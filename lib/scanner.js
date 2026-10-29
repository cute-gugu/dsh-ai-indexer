/**
 * Workspace walking + incremental file analysis.
 *
 * The scanner never parses function bodies. It answers one question per run:
 * "which source files exist, what do their comments claim, and which of them
 * changed since the last scan?" Everything downstream is derived from that.
 *
 * @module dsh-ai-indexer/scanner
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  CODE_EXT,
  DEFAULT_IGNORE_DIRS,
  DEFAULT_IGNORE_FILES,
  countPendingMarkers,
  extractDeps,
  extractSymbols,
  extOf,
  familyOf,
  parseMarkers,
} from './markers.js';
import { stripGeneratedBlock } from './store.js';

/** Strip a UTF-8 BOM and collapse CRLF so a Windows checkout hashes like a Unix one. */
export function normalizeText(raw) {
  let text = String(raw ?? '');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n?/g, '\n');
}

/** Short content digest used for change detection and the project fingerprint. */
export function hashText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

/**
 * Walk the workspace and return every scannable file plus the caps that were hit.
 *
 * Caps are reported rather than silently applied: a truncated index that looks
 * complete is worse than one that admits it is partial.
 *
 * @param fs - host `fs` service.
 * @param rootTarget - resolved workspace directory target.
 * @param options - merged scan options.
 */
export async function walkWorkspace(fs, rootTarget, options) {
  const ignoreDirs = new Set([...DEFAULT_IGNORE_DIRS, ...(options.ignoreDirs ?? [])]);
  const ignoreFiles = new Set([...DEFAULT_IGNORE_FILES, ...(options.ignoreFiles ?? [])]);
  const exts = new Set([...CODE_EXT, ...(options.extraExtensions ?? [])].map((e) => (e.startsWith('.') ? e : `.${e}`)));
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 12;
  const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : 4000;
  const maxFileBytes = Number.isFinite(options.maxFileBytes) ? options.maxFileBytes : 1048576;

  const files = [];
  const skippedLarge = [];
  const unreadable = [];
  let truncatedFiles = false;
  let truncatedDepth = false;
  let dirCount = 0;
  let blocked = false;

  const walk = async (target, prefix, depth) => {
    if (blocked) return;
    let entries;
    try {
      entries = await fs.listDir(target);
    } catch (error) {
      unreadable.push({ rel: prefix || '.', reason: describeError(error) });
      return;
    }
    for (const entry of entries) {
      if (blocked) return;
      if (files.length >= maxFiles) {
        truncatedFiles = true;
        blocked = true;
        return;
      }
      const name = entry.name;
      const rel = prefix ? `${prefix}/${name}` : name;
      if (entry.type === 'directory') {
        if (ignoreDirs.has(name)) continue;
        if (depth + 1 > maxDepth) {
          truncatedDepth = true;
          continue;
        }
        dirCount += 1;
        await walk(entry.target, rel, depth + 1);
        continue;
      }
      if (entry.type !== 'file') continue;
      if (ignoreFiles.has(name)) continue;
      const ext = extOf(name);
      if (!exts.has(ext)) continue;
      if (typeof entry.size === 'number' && entry.size > maxFileBytes) {
        skippedLarge.push({ rel, size: entry.size });
        continue;
      }
      files.push({
        rel,
        ext,
        size: entry.size,
        version: typeof entry.version === 'string' ? entry.version : undefined,
        target: entry.target,
      });
    }
  };

  await walk(rootTarget, '', 0);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, skippedLarge, unreadable, truncatedFiles, truncatedDepth, dirCount };
}

/**
 * Read every file whose filesystem version moved, reusing cached analyses else.
 *
 * `version` is the host's own file identity, so a save that changes nothing on
 * disk (touch, git checkout of identical bytes) does not cost a re-read.
 *
 * @param fs - host `fs` service.
 * @param walked - result of {@link walkWorkspace}.
 * @param previous - per-path analysis records from the last scan.
 */
export async function analyzeFiles(fs, walked, previous = {}) {
  const files = Object.create(null);
  const failed = [];
  let read = 0;
  let reused = 0;

  for (const entry of walked.files) {
    const cached = previous[entry.rel];
    const key = entry.version ?? `size:${entry.size ?? 'unknown'}`;
    if (cached && cached.v === key && typeof cached.hash === 'string') {
      files[entry.rel] = cached;
      reused += 1;
      continue;
    }
    let text;
    try {
      text = normalizeText(await fs.readText(entry.target));
    } catch (error) {
      failed.push({ rel: entry.rel, reason: describeError(error) });
      if (cached) files[entry.rel] = cached;
      continue;
    }
    read += 1;
    const family = familyOf(entry.ext);
    // The generated README block is our own output, so it must not feed the hash.
    const content = stripGeneratedBlock(text);
    const markers = parseMarkers(content);
    files[entry.rel] = {
      v: key,
      ext: entry.ext,
      fam: family,
      size: typeof entry.size === 'number' ? entry.size : text.length,
      lines: text.length === 0 ? 0 : text.split('\n').length,
      hash: hashText(content),
      pending: countPendingMarkers(content),
      markers: markers.fields,
      symbols: extractSymbols(content, family, 80),
      deps: extractDeps(content, 24),
    };
  }

  return { files, failed, read, reused };
}

/** Stable fingerprint over the whole scanned set: same bytes in, same digest out. */
export function fingerprintOf(files) {
  const lines = Object.keys(files)
    .sort()
    .map((rel) => `${rel}\u0000${files[rel].hash ?? files[rel].v ?? ''}`);
  return hashText(lines.join('\n'));
}

/** Short, non-leaking description of a filesystem failure. */
export function describeError(error) {
  if (!error) return 'unknown error';
  const code = typeof error.code === 'string' ? error.code : undefined;
  const message = typeof error.message === 'string' ? error.message : String(error);
  const first = message.split('\n')[0].slice(0, 160);
  return code && !first.includes(code) ? `${code}: ${first}` : first;
}

export { DEFAULT_IGNORE_DIRS, DEFAULT_IGNORE_FILES, CODE_EXT, familyOf, extOf, path };
