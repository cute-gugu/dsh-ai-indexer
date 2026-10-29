/**
 * Language-agnostic extraction: comment markers, top-level symbols, dependencies.
 *
 * Everything here is regex-based on purpose. A fast scan must not parse function
 * bodies, and the index is a hint surface rather than a compiler: symbols are
 * reported as observations, never as proven signatures.
 *
 * @module dsh-ai-indexer/markers
 */
import path from 'node:path';

/** Directory names never walked. Merge with meta.json's `ignoreDirs`. */
export const DEFAULT_IGNORE_DIRS = [
  '.git', '.hg', '.svn', '.ai-index',
  'node_modules', 'bower_components', 'vendor', 'third_party', 'Pods', 'DerivedData',
  'dist', 'build', 'out', 'output', 'target', 'coverage', '.nyc_output',
  '.next', '.nuxt', '.svelte-kit', '.parcel-cache', '.cache', '.turbo',
  '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.eggs',
  '.idea', '.vs', '.vscode', '.gradle', '.mvn', 'obj', 'bin', 'Debug', 'Release', 'x64', 'CMakeFiles',
  '.terraform', '.serverless', 'tmp', 'temp',
];

/** File names never scanned even when the extension is whitelisted. */
export const DEFAULT_IGNORE_FILES = [
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'composer.lock', 'poetry.lock',
  'Cargo.lock', 'Gemfile.lock', 'go.sum', 'gradle.lockfile',
];

/** Extensions the scanner reads. Anything else is skipped as data. */
export const CODE_EXT = new Set([
  '.lua', '.toc', '.xml',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.astro',
  '.py', '.pyi', '.rb', '.php', '.pl', '.pm', '.r', '.jl', '.m', '.mm', '.swift', '.kt', '.kts',
  '.go', '.rs', '.java', '.cs', '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hxx', '.dart', '.zig', '.nim',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.bat', '.cmd',
  '.sql', '.graphql', '.proto', '.thrift',
  '.json', '.jsonc', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.properties', '.env',
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.styl',
  '.md', '.mdx', '.rst', '.adoc', '.txt',
  '.asm', '.s', '.f90', '.hs', '.ex', '.exs', '.erl', '.clj', '.cljs',
]);

const FAMILY_BY_EXT = {
  '.lua': 'lua', '.toc': 'lua',
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js', '.ts': 'js', '.tsx': 'js', '.vue': 'js', '.svelte': 'js', '.astro': 'js',
  '.py': 'py', '.pyi': 'py',
  '.rb': 'py', '.jl': 'py',
  '.go': 'go',
  '.rs': 'rs',
  '.java': 'clike', '.cs': 'clike', '.kt': 'clike', '.kts': 'clike', '.dart': 'clike', '.swift': 'clike', '.zig': 'clike',
  '.c': 'clike', '.h': 'clike', '.cc': 'clike', '.cpp': 'clike', '.cxx': 'clike',
  '.hpp': 'clike', '.hxx': 'clike', '.m': 'clike', '.mm': 'clike', '.php': 'clike',
  '.sh': 'sh', '.bash': 'sh', '.zsh': 'sh', '.fish': 'sh', '.ps1': 'sh', '.psm1': 'sh',
};

/**
 * Resolve the pattern family used to pull symbols out of one file.
 * @param ext - lowercased file extension, with the dot.
 * @returns the family key, or `generic`.
 */
export function familyOf(ext) {
  return FAMILY_BY_EXT[ext] ?? 'generic';
}

/** Regex sources per family, compiled per call so lastIndex never leaks between files. */
const SYMBOL_SOURCES = {
  lua: [
    '^[ \\t]*(?:local[ \\t]+)?function[ \\t]+([A-Za-z_][\\w.:]*)',
    '^[ \\t]*([A-Za-z_][\\w.:]*)[ \\t]*=[ \\t]*function',
  ],
  js: [
    '^[ \\t]*export[ \\t]+(?:default[ \\t]+)?(?:async[ \\t]+)?function[ \\t]+([A-Za-z_$][\\w$]*)',
    '^[ \\t]*export[ \\t]+(?:abstract[ \\t]+)?(?:const|let|var|class)[ \\t]+([A-Za-z_$][\\w$]*)',
    '^[ \\t]*(?:async[ \\t]+)?function[ \\t]+([A-Za-z_$][\\w$]*)',
    '^[ \\t]*class[ \\t]+([A-Za-z_$][\\w$]*)',
    '^[ \\t]*(?:const|let|var)[ \\t]+([A-Za-z_$][\\w$]*)[ \\t]*=[ \\t]*(?:async[ \\t]*)?\\(',
  ],
  py: [
    '^[ \\t]*def[ \\t]+([A-Za-z_]\\w*)',
    '^[ \\t]*class[ \\t]+([A-Za-z_]\\w*)',
  ],
  go: [
    '^func[ \\t]+\\([^)]*\\)[ \\t]*([A-Za-z_]\\w*)',
    '^func[ \\t]+([A-Za-z_]\\w*)',
    '^type[ \\t]+([A-Za-z_]\\w*)',
  ],
  rs: [
    '^[ \\t]*pub[ \\t]+(?:async[ \\t]+)?fn[ \\t]+([A-Za-z_]\\w*)',
    '^[ \\t]*fn[ \\t]+([A-Za-z_]\\w*)',
    '^[ \\t]*pub[ \\t]+(?:struct|enum|trait|type)[ \\t]+([A-Za-z_]\\w*)',
    '^[ \\t]*(?:struct|enum|trait|type)[ \\t]+([A-Za-z_]\\w*)',
  ],
  sh: [
    '^[ \\t]*function[ \\t]+([A-Za-z_][\\w-]*)',
    '^[ \\t]*(?:async[ \\t]+)?([A-Za-z_][\\w-]*)[ \\t]*\\(\\)[ \\t]*\\{',
  ],
  clike: [
    '^[ \\t]*(?:public|private|protected|internal|static|final|virtual|override|export|extern|inline|synchronized|abstract|sealed|declare|#[a-z]+)*[ \\t]*[A-Za-z_][\\w:<>,.\\[\\]*&]*[ \\t]+([A-Za-z_]\\w*)[ \\t]*\\(',
    '^[ \\t]*(?:public|internal|private|protected|final|abstract|sealed|export|declare)*[ \\t]*(?:class|struct|interface|enum|trait|protocol)[ \\t]+([A-Za-z_]\\w*)',
  ],
  generic: [
    '^[ \\t]*(?:export[ \\t]+)?(?:async[ \\t]+)?function[ \\t]+([A-Za-z_$][\\w$]*)',
    '^[ \\t]*(?:export[ \\t]+)?(?:class|interface|struct|enum|trait)[ \\t]+([A-Za-z_$][\\w$]*)',
    '^[ \\t]*def[ \\t]+([A-Za-z_]\\w*)',
  ],
};

const DEP_SOURCES = [
  '\\brequire[ \\t]*\\([ \\t]*[\'"`]([^\'"`]+)[\'"`]',
  '\\bfrom[ \\t]+[\'"`]([^\'"`]+)[\'"`]',
  '^[ \\t]*import[ \\t]+[\'"`]([^\'"`]+)[\'"`]',
  '^[ \\t]*#[ \\t]*include[ \\t]+[<"]([^>"]+)[>"]',
  '^[ \\t]*(?:use|extern[ \\t]+crate)[ \\t]+([A-Za-z_][\\w:]*)',
  '^[ \\t]*(?:from|import)[ \\t]+([A-Za-z_][\\w.]*)',
  '^[ \\t]*[A-Za-z_][\\w.]*[ \\t]*=[ \\t]*require\\(',
];

/**
 * Pull `@ai:key value` observations out of any comment syntax.
 *
 * A marker is recognised wherever the text `@ai:<key>` appears; the value runs to
 * the end of the line and then loses whatever comment closer trails it
 * (a block-comment end, an HTML comment end, a wiki close, or a trailing `;`).
 *
 * @param text - normalized file text.
 * @returns `{ fields, raw }` — fields keyed by marker name, plus the ordered raw list.
 */
export function parseMarkers(text) {
  const fields = Object.create(null);
  const raw = [];
  const re = new RegExp('@ai:([A-Za-z][A-Za-z0-9_-]*)[ \\t]*([^\\r\\n]*)', 'g');
  for (const match of text.matchAll(re)) {
    const key = match[1].toLowerCase();
    const value = cleanValue(match[2]);
    (fields[key] ??= []).push(value);
    raw.push({ key, value });
    if (raw.length >= 200) break;
  }
  return { fields, raw };
}

function cleanValue(input) {
  let value = String(input ?? '');
  for (let pass = 0; pass < 3; pass += 1) {
    const before = value;
    value = value.replace(/\s*(\*\/|-->|\]\]|#>|;)\s*$/, '');
    value = value.replace(/^\s*[:=]\s*/, '');
    value = value.trim();
    if (value === before) break;
  }
  return value;
}

/** First value of a marker key, or undefined. */
export function firstOf(fields, key) {
  const list = fields[key];
  return list && list.length > 0 ? list[0] : undefined;
}

/** All values of a marker key, flattened across comma-separated lists. */
export function listOf(fields, key) {
  const list = fields[key];
  if (!list) return [];
  const out = [];
  for (const entry of list) {
    for (const part of String(entry).split(',')) {
      const trimmed = part.trim();
      if (trimmed.length > 0) out.push(trimmed);
    }
  }
  return [...new Set(out)];
}

/**
 * Collect candidate top-level symbol names from one file.
 * @param text - normalized file text.
 * @param fam - family key from {@link familyOf}.
 * @param limit - maximum names returned.
 */
export function extractSymbols(text, fam, limit = 120) {
  const sources = SYMBOL_SOURCES[fam] ?? SYMBOL_SOURCES.generic;
  const names = new Set();
  for (const source of sources) {
    for (const match of text.matchAll(new RegExp(source, 'gm'))) {
      const name = match[1];
      if (typeof name === 'string' && name.length > 0) names.add(name);
      if (names.size >= limit) break;
    }
    if (names.size >= limit) break;
  }
  // Fall back to the generic family when a specialized scan found nothing at all.
  if (names.size === 0 && fam !== 'generic') {
    return extractSymbols(text, 'generic', limit);
  }
  return [...names].sort();
}

/**
 * Collect dependency specifiers from one file.
 * @param text - normalized file text.
 * @param limit - maximum specifiers returned.
 */
export function extractDeps(text, limit = 40) {
  const names = new Set();
  for (const source of DEP_SOURCES) {
    for (const match of text.matchAll(new RegExp(source, 'gm'))) {
      const spec = match[1];
      if (typeof spec !== 'string' || spec.length === 0 || spec.length > 200) continue;
      names.add(spec);
      if (names.size >= limit) break;
    }
    if (names.size >= limit) break;
  }
  return [...names].sort();
}

/**
 * Split an `@ai:contract` value into the identifiers it claims to expose.
 *
 * Only names that could plausibly be an exported symbol are kept, so prose in a
 * contract line does not turn into a false missing-symbol report.
 *
 * @param value - one contract line.
 * @returns claimed identifier names.
 */
export function contractNames(value) {
  const names = new Set();
  for (const match of String(value ?? '').matchAll(/([A-Za-z_][\w.]*)[ \t]*\(/g)) {
    const raw = match[1];
    const tail = raw.includes('.') ? raw.split('.').pop() : raw;
    if (tail && tail.length > 1) names.add(tail);
  }
  if (names.size === 0) {
    for (const match of String(value ?? '').matchAll(/:([ \t]*)([A-Za-z_][\w.]*)/g)) {
      const raw = match[2];
      const tail = raw.includes('.') ? raw.split('.').pop() : raw;
      if (tail && tail.length > 1) names.add(tail);
    }
  }
  return [...names];
}

/** Count trailing-work markers, which contradict an `@ai:status done`. */
export function countPendingMarkers(text) {
  let count = 0;
  for (const _ of text.matchAll(/\b(TODO|FIXME|XXX|HACK)\b/g)) count += 1;
  return count;
}

/**
 * Derive the module a marker-less file belongs to: the directory it sits in.
 *
 * The fallback keeps the registry useful in repositories that carry no markers at
 * all — which is every repository on the first scan.
 *
 * @param rel - workspace-relative file path with forward slashes.
 * @param depth - how many path segments make up a module id.
 */
export function directoryModule(rel, depth = 2) {
  const parts = rel.split('/');
  parts.pop();
  if (parts.length === 0) return '.';
  return parts.slice(0, Math.max(1, depth)).join('/');
}

/** Lowercased extension including the dot. */
export function extOf(name) {
  return path.extname(name).toLowerCase();
}
