/**
 * Storage layer: the four files this plugin owns, plus rendering.
 *
 * The split exists so that "what a human edits" and "what the tool rewrites"
 * never occupy the same bytes:
 *
 * | file                    | owner  | injected into a prompt?      |
 * |-------------------------|--------|------------------------------|
 * | `.ai-index/meta.json`   | human  | no                           |
 * | `.ai-index/index.json`  | tool   | no                           |
 * | `.ai-index/snapshot.md` | tool   | yes — the `stable` half only |
 * | `.ai-index/master.md`   | tool   | only when asked for          |
 * | `.ai-index/cache.json`  | tool   | no                           |
 *
 * @module dsh-ai-indexer/store
 */
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

export const INDEX_DIR = '.ai-index';
export const README = 'README.md';
export const META_FILE = `${INDEX_DIR}/meta.json`;
export const STATE_FILE = `${INDEX_DIR}/index.json`;
export const SNAPSHOT_FILE = `${INDEX_DIR}/snapshot.md`;
export const MASTER_FILE = `${INDEX_DIR}/master.md`;
export const CACHE_FILE = `${INDEX_DIR}/cache.json`;

export const SYNC_START = '<!-- ai-index:sync -->';
export const SYNC_END = '<!-- /ai-index:sync -->';
export const SNAPSHOT_START = '<!-- dsh-ai-indexer:snapshot v1 -->';
export const SNAPSHOT_END = '<!-- dsh-ai-indexer:end -->';

/** Marker names the scanner understands, with the meaning of each. */
export const MARKER_SPEC = [
  ['@ai:module <名字>', '把这个文件归到哪个模块；省略时按所在目录自动归组'],
  ['@ai:status done|wip|planned|blocked|deprecated|frozen', '模块状态，进入进度看板'],
  ['@ai:contract <说明或 函数名()>', '对外承诺；函数名会被拿去和源码里的符号核对，不一致就报风险'],
  ['@ai:risk <一句话>', '已知风险，直接进风险面板'],
  ['@ai:note <一句话>', '给下一位读者留的说明'],
  ['@ai:deps <名字或相对路径>', '依赖项；写成项目内相对路径且磁盘上不存在时会告警'],
  ['@ai:ref <项目或链接>', '同类实现 / 参考来源'],
  ['@ai:ecosystem <标签>', '生态标签，用于轮子检索时的关键词'],
  ['@ai:owner <子系统或人>', '归属'],
];

/**
 * Default meta. Written once with `createIfAbsent` and never overwritten —
 * a human edit here is authoritative.
 */
export const DEFAULT_META = {
  $note: 'dsh-ai-indexer 的人工配置文件。本文件只在你手动修改时变化，插件永不覆盖它。',
  version: 1,
  enabled: true,
  injectSnapshot: true,
  snapshotTemplate: 'general',
  snapshotBudgetTokens: 1200,
  snapshotModuleLimit: 40,
  snapshotChangeLimit: 8,
  injectOrder: 60,
  watch: false,
  watchDebounceMs: 800,
  moduleDepth: 2,
  maxDepth: 12,
  maxFiles: 4000,
  maxFileBytes: 1048576,
  staleScans: 5,
  changeSliceLimit: 20,
  ignoreDirs: [],
  ignoreFiles: [],
  extraExtensions: [],
  advisor: {
    enabled: true,
    maxQuestions: 4,
    priority: ['risk', 'gap', 'expand'],
    skipSmallFix: true,
    minChangedFiles: 1,
    timeoutMs: 180000,
    locale: ['zh'],
  },
  wheel: {
    enabled: true,
    tierGrading: 'model',
    cacheDays: 7,
  },
};

/** Deep-merge a loaded meta over the defaults, keeping unknown human keys. */
export function mergeMeta(loaded) {
  const base = structuredClone(DEFAULT_META);
  if (!loaded || typeof loaded !== 'object') return base;
  for (const [key, value] of Object.entries(loaded)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      base[key] = { ...base[key], ...value };
    } else {
      base[key] = value;
    }
  }
  return base;
}

/** CJK-aware token estimate. Deterministic, offline, and good enough to cap a budget. */
export function estimateTokens(text) {
  let wide = 0;
  let narrow = 0;
  for (const char of String(text ?? '')) {
    const cp = char.codePointAt(0);
    if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60)) {
      wide += 1;
    } else {
      narrow += 1;
    }
  }
  return Math.ceil(wide * 1.05 + narrow / 4);
}

function conflictCode(error) {
  return String(error?.code ?? error?.message ?? '');
}

/**
 * The host's `fs` service has no mkdir. If its `writeText` refuses to create
 * missing parents, create them once through node's own fs and retry — a no-op
 * on virtual filesystems whose first write already succeeded.
 */
async function tryCreateParent(target) {
  try {
    await mkdir(path.dirname(target.displayPath), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Write one file, keeping the previous version's identity as a precondition.
 *
 * A stale precondition is retried once against a freshly read version; anything
 * else propagates so a real failure is visible instead of silently swallowed.
 */
export async function writeFileAtomic(fs, root, rel, content, mode = 'replace') {
  const target = await fs.resolve(rel, { cwd: root });
  let parentCreated = false;

  const attemptWrite = async (expected) => {
    try {
      return await fs.writeText(target, content, expected);
    } catch (error) {
      if (!parentCreated && /ENOENT|not exist|no such file/i.test(conflictCode(error))) {
        parentCreated = await tryCreateParent(target);
        if (parentCreated) return await fs.writeText(target, content, expected);
      }
      throw error;
    }
  };

  if (mode === 'create-only') {
    try {
      await attemptWrite({ kind: 'createIfAbsent' });
      return { created: true };
    } catch (error) {
      if (/exist/i.test(conflictCode(error))) return { created: false };
      throw error;
    }
  }

  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const info = await fs.stat(target);
    const expected = info ? { kind: 'replaceIfVersion', version: info.version } : { kind: 'createIfAbsent' };
    try {
      await attemptWrite(expected);
      return { created: !info };
    } catch (error) {
      lastError = error;
      if (!/stale|exist|version/i.test(conflictCode(error))) throw error;
    }
  }
  throw lastError;
}

/** Read a UTF-8 file, returning undefined when it does not exist. */
export async function readFileIfPresent(fs, root, rel) {
  try {
    const target = await fs.resolve(rel, { cwd: root });
    const info = await fs.stat(target);
    if (!info || info.type !== 'file') return undefined;
    return { text: await fs.readText(target), version: info.version, target };
  } catch {
    return undefined;
  }
}

/** Parse JSON with a fallback instead of throwing on a hand-edited file. */
export function parseJson(text, fallback) {
  if (typeof text !== 'string' || text.trim().length === 0) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export async function loadMeta(fs, root) {
  const found = await readFileIfPresent(fs, root, META_FILE);
  const parsed = found ? parseJson(found.text, undefined) : undefined;
  return {
    meta: mergeMeta(parsed),
    existed: Boolean(found),
    corrupt: Boolean(found && parsed === undefined),
  };
}

export async function loadState(fs, root) {
  const found = await readFileIfPresent(fs, root, STATE_FILE);
  return parseJson(found?.text, { v: 1, scan: 0, files: {}, modules: {}, changes: [], wheelCache: [] });
}

export async function loadCache(fs, root) {
  const found = await readFileIfPresent(fs, root, CACHE_FILE);
  return parseJson(found?.text, { v: 1, entries: [] });
}

/** Render the injected half of a document: everything before the volatile tail. */
export function stableHalf(text) {
  const end = text.indexOf(SNAPSHOT_END);
  if (end < 0) return text;
  return text.slice(0, end + SNAPSHOT_END.length);
}

/**
 * Remove the generated README block before the file is hashed.
 *
 * The block quotes the project fingerprint, so without this the fingerprint
 * would depend on the README, which depends on the fingerprint, and no scan
 * could ever be a no-op. The plugin must not observe its own output.
 */
export function stripGeneratedBlock(text) {
  const start = text.indexOf(SYNC_START);
  let head = text;
  if (start >= 0) {
    const end = text.indexOf(SYNC_END, start);
    head = end < 0 ? text.slice(0, start) : `${text.slice(0, start)}${text.slice(end + SYNC_END.length)}`;
  }
  // Normalize trailing whitespace for every file, block or no block. This is the
  // part that actually breaks the feedback loop: appending the block adds a
  // separator and a trailing newline, and both vanish here, so the hash basis of
  // a README without the block and the same README with it are byte-identical --
  // and the fingerprint is stable from the very first scan.
  const trimmed = head.replace(/\s+$/, '');
  return trimmed.length > 0 ? `${trimmed}\n` : '';
}

/** A compact directory tree built from the scanned file list. */
export function renderTree(paths, options = {}) {
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 3;
  const maxEntries = Number.isFinite(options.maxEntries) ? options.maxEntries : 120;
  const root = { dirs: new Map(), files: [] };
  for (const rel of paths) {
    const parts = rel.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (i >= maxDepth) break;
      const name = parts[i];
      if (!node.dirs.has(name)) node.dirs.set(name, { dirs: new Map(), files: [] });
      node = node.dirs.get(name);
    }
    if (parts.length - 1 <= maxDepth) node.files.push(parts[parts.length - 1]);
  }
  const out = [];
  let emitted = 0;
  const emit = (node, prefix, depth) => {
    if (emitted >= maxEntries) return;
    const dirNames = [...node.dirs.keys()].sort();
    for (const name of dirNames) {
      if (emitted >= maxEntries) return;
      out.push(`${prefix}${name}/`);
      emitted += 1;
      emit(node.dirs.get(name), `${prefix}  `, depth + 1);
    }
    const files = node.files.sort();
    const shown = files.slice(0, 12);
    for (const file of shown) {
      if (emitted >= maxEntries) return;
      out.push(`${prefix}${file}`);
      emitted += 1;
    }
    if (files.length > shown.length) {
      out.push(`${prefix}… 另有 ${files.length - shown.length} 个文件`);
      emitted += 1;
    }
  };
  emit(root, '', 0);
  return out.join('\n');
}

function progressBar(counts) {
  const order = [['done', '✅'], ['wip', '🚧'], ['planned', '📝'], ['blocked', '⛔'], ['deprecated', '🗑️'], ['frozen', '🧊'], ['unknown', '❔']];
  return order
    .filter(([key]) => (counts[key] ?? 0) > 0)
    .map(([key, icon]) => `${icon} ${key} ${counts[key]}`)
    .join('　');
}

function moduleRow(module) {
  const contracts = module.contracts.length > 0 ? `${module.contracts.length}` : '-';
  const risks = module.risks.length > 0 ? `${module.risks.length}` : '-';
  const refs = module.refs.length > 0 ? module.refs.slice(0, 2).map((r) => r.text).join(', ') : '-';
  const deps = module.declaredDeps.size > 0 ? [...module.declaredDeps].slice(0, 3).join(', ') : '-';
  const archived = module.effectiveStatus === 'deprecated' || module.effectiveStatus === 'frozen' ? '归档' : '';
  return `| ${module.id} | ${module.files.length} | ${module.effectiveStatus} | ${deps} | ${contracts} | ${risks} | ${refs} | ${archived} |`;
}

/**
 * Render the full human/AI master index.
 * @returns markdown text.
 */
export function renderMaster(context) {
  const { meta, state, modules, risks, changes, stats, workspace, tree } = context;
  const lines = [];
  lines.push(`# AI 项目索引 · ${path.basename(workspace)}（自动生成，请勿大量手改）`);
  lines.push('');
  lines.push(`> 指纹：\`${state.hash}\`　更新：${state.at}　扫描模式：${state.mode ?? 'fast'}　第 ${state.scan} 次扫描`);
  lines.push('> 对话默认读取快照 `.ai-index/snapshot.md`；需要细节时再读本文件。');
  const ecosystems = new Set();
  for (const module of modules.values()) for (const eco of module.ecosystems) ecosystems.add(eco);
  if (ecosystems.size > 0) lines.push(`> 生态标签：${[...ecosystems].sort().join(', ')}`);
  lines.push('');
  lines.push('## 项目总览');
  lines.push(`- 工作区：\`${workspace}\``);
  lines.push(`- 模块 ${stats.modules} 个（其中 ${stats.markedModules} 个带 @ai:module 标记）· 源文件 ${stats.files} 个 · 未完成标记 ${stats.pending} 处`);
  lines.push(`- 风险：${stats.risks.warn ?? 0} 条告警 / ${stats.risks.info ?? 0} 条提示`);
  lines.push('- 改索引的唯一方式：改源码里的 `@ai:` 标记，然后 `ai_index_scan`。插件永不被手写索引覆盖源码事实。');
  lines.push('');
  lines.push(`## 变更切片（最近 ${Math.min(changes.length, meta.changeSliceLimit ?? 20)} 条）`);
  if (changes.length === 0) {
    lines.push('- （本次扫描没有检测到变化）');
  } else {
    for (const change of changes.slice(0, meta.changeSliceLimit ?? 20)) {
      const tag = change.kind === 'added' ? '新增' : change.kind === 'removed' ? '删除' : '改动';
      lines.push(`- [第 ${change.scan ?? state.scan} 次扫描] ${tag} \`${change.rel}\`${change.detail ? ` · ${change.detail}` : ''}`);
    }
  }
  lines.push('');
  lines.push('## 目录树');
  lines.push('```');
  lines.push(tree || '（空）');
  lines.push('```');
  lines.push('');
  lines.push('## 模块注册表');
  lines.push('| 模块 | 文件 | 状态 | 依赖 | 契约 | 风险 | 参考 | 归档 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  const sorted = [...modules.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const module of sorted) lines.push(moduleRow(module));
  if (sorted.length === 0) lines.push('| （无源码文件） | 0 | unknown | - | - | - | - |  |');
  lines.push('');
  lines.push('## 依赖简表');
  const declared = new Map();
  for (const module of modules.values()) {
    for (const dep of module.declaredDeps) {
      if (!declared.has(dep)) declared.set(dep, []);
      declared.get(dep).push(module.id);
    }
  }
  if (declared.size === 0) {
    lines.push('- 未发现 `@ai:deps` 声明。');
  } else {
    for (const [dep, owners] of [...declared.entries()].sort()) {
      lines.push(`- \`${dep}\` ← ${owners.slice(0, 6).join(', ')}`);
    }
  }
  lines.push('');
  lines.push('## 风险与告警面板');
  if (risks.length === 0) {
    lines.push('- 无。');
  } else {
    for (const risk of risks.slice(0, 200)) {
      const icon = risk.severity === 'warn' ? '⚠️' : risk.severity === 'error' ? '⛔' : 'ℹ️';
      lines.push(`- ${icon} [${risk.kind}]${risk.module ? ` \`${risk.module}\`` : ''} ${risk.message}${risk.evidence ? `　（${risk.evidence}）` : ''}`);
    }
  }
  lines.push('');
  lines.push('## 开发进度看板');
  lines.push(progressBar(stats.statuses) || '（无状态标记）');
  lines.push('');
  const notes = [];
  for (const module of sorted) {
    for (const note of module.notes) notes.push(`- \`${module.id}\`（${note.rel}）：${note.text}`);
    for (const risk of module.risks) notes.push(`- \`${module.id}\` 风险（${risk.rel}）：${risk.text}`);
  }
  lines.push('## 待办与备注');
  if (notes.length === 0) lines.push('- 无。');
  else for (const note of notes.slice(0, 120)) lines.push(note);
  lines.push('');
  const archived = sorted.filter((module) => module.effectiveStatus === 'deprecated' || module.effectiveStatus === 'frozen');
  lines.push('## 归档模块区（不进快照）');
  if (archived.length === 0) lines.push('- 无。');
  else for (const module of archived) lines.push(`- \`${module.id}\`（${module.files.length} 个文件）`);
  lines.push('');
  lines.push('## 标记规范');
  for (const [syntax, meaning] of MARKER_SPEC) lines.push(`- \`${syntax}\`：${meaning}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Render the snapshot under a hard token budget.
 *
 * Blocks are emitted in priority order and the loop stops at the budget, so a
 * large project degrades into a shorter snapshot instead of an unbounded one.
 *
 * @returns `{ full, stable, tokens, dropped }`.
 */
export function renderSnapshot(context) {
  const { meta, state, modules, risks, changes, stats, workspace } = context;
  const template = meta.snapshotTemplate ?? 'general';
  const budget = Number.isFinite(meta.snapshotBudgetTokens) ? meta.snapshotBudgetTokens : 1200;
  const blocks = [];

  const header = [
    SNAPSHOT_START,
    `# 项目索引快照 · ${path.basename(workspace)}`,
    `指纹 ${state.hash}｜模块 ${stats.modules}｜文件 ${stats.files}｜告警 ${(stats.risks.warn ?? 0)}`,
    '本快照由 dsh-ai-indexer 自动生成，是项目现状的摘要而非全量事实；需要细节时读 `.ai-index/master.md`、用 `ai_index_query`，或直接读对应源文件。',
  ].join('\n');
  blocks.push({ id: 'header', text: header });

  const actionable = risks.filter((risk) => risk.severity !== 'info');
  if (actionable.length > 0) {
    blocks.push({
      id: 'risks',
      text: ['## 需要留意的风险', ...actionable.slice(0, 12).map((risk) => `- [${risk.kind}]${risk.module ? ` ${risk.module}` : ''}：${risk.message}`)].join('\n'),
    });
  }

  const nonArchived = [...modules.values()]
    .filter((module) => module.effectiveStatus !== 'deprecated' && module.effectiveStatus !== 'frozen')
    .sort((a, b) => rank(b) - rank(a) || (a.id < b.id ? -1 : 1));
  const moduleLimit = Number.isFinite(meta.snapshotModuleLimit) ? meta.snapshotModuleLimit : 40;
  const listed = nonArchived.slice(0, moduleLimit);
  if (listed.length > 0) {
    const board = listed.map((module) => {
      const bits = [`- \`${module.id}\` ${module.effectiveStatus}`];
      if (module.contracts.length > 0) bits.push(`契约：${module.contracts[0].text.slice(0, 60)}`);
      if (module.risks.length > 0) bits.push(`风险：${module.risks[0].text.slice(0, 60)}`);
      return bits.join('　');
    });
    const tail = nonArchived.length > listed.length ? `\n（另有 ${nonArchived.length - listed.length} 个模块未列出，读 master.md 取全量）` : '';
    blocks.push({ id: 'modules', text: ['## 模块与状态', ...board, tail].filter(Boolean).join('\n') });
  }

  if (changes.length > 0) {
    const limit = Number.isFinite(meta.snapshotChangeLimit) ? meta.snapshotChangeLimit : 8;
    blocks.push({
      id: 'changes',
      text: [
        '## 最近变化',
        ...changes.slice(0, limit).map((change) => {
          const tag = change.kind === 'added' ? '新增' : change.kind === 'removed' ? '删除' : '改动';
          return `- ${tag} \`${change.rel}\``;
        }),
      ].join('\n'),
    });
  }

  if (template === 'deep') {
    const contractLines = [];
    for (const module of listed) {
      for (const contract of module.contracts.slice(0, 2)) contractLines.push(`- \`${module.id}\`：${contract.text.slice(0, 100)}`);
    }
    if (contractLines.length > 0) blocks.push({ id: 'contracts', text: ['## 对外契约', ...contractLines.slice(0, 30)].join('\n') });
  }

  blocks.push({
    id: 'usage',
    text: [
      '## 怎么用这份索引',
      '- 先信任本快照，不要为此重扫整个仓库。',
      '- 要动手改某个模块前，读该模块源文件与 `@ai:` 标记；标记是唯一事实来源。',
      '- 改了模块的对外接口、状态或依赖，就在同一份源码里更新对应 `@ai:` 标记，然后调用 `ai_index_scan`。',
      '- `ai_index_query` 可按模块或关键词检索索引；`ai_index_wheel` 在动手实现通用设施前先查有没有现成轮子。',
    ].join('\n'),
  });

  const vouchers = [];
  const out = [];
  let tokens = 0;
  let dropped = 0;
  for (const block of blocks) {
    const size = estimateTokens(block.text) + 1;
    if (tokens + size > budget && out.length > 0) {
      dropped += 1;
      continue;
    }
    out.push(block.text);
    tokens += size;
    vouchers.push(block.id);
  }
  const stable = `${out.join('\n\n')}\n${SNAPSHOT_END}`;
  const volatile = `\n<!-- volatile（不注入对话）：生成于 ${state.at}，第 ${state.scan} 次扫描，指纹 ${state.hash} -->`;
  return { stable, full: `${stable}${volatile}\n`, tokens, dropped, included: vouchers };
}

function rank(module) {
  let score = 0;
  if (module.risks.length > 0) score += 40;
  if (module.effectiveStatus === 'wip' || module.effectiveStatus === 'blocked') score += 20;
  if (module.contracts.length > 0) score += 10;
  score += Math.min(module.files.length, 10);
  return score;
}

/**
 * Update only the generated block inside README, leaving every other byte alone.
 * @returns which action was taken, for reporting back to the caller.
 */
export async function syncReadme(fs, root, block) {
  const found = await readFileIfPresent(fs, root, README);
  const wrapped = `${SYNC_START}\n${block.trim()}\n${SYNC_END}`;
  if (!found) {
    await writeFileAtomic(fs, root, README, `# ${path.basename(root)}\n\n${wrapped}\n`);
    return 'created';
  }
  const text = found.text;
  const start = text.indexOf(SYNC_START);
  const end = text.indexOf(SYNC_END);
  if (start >= 0 && end > start) {
    const before = text.slice(0, start);
    const after = text.slice(end + SYNC_END.length);
    const next = `${before}${wrapped}${after}`;
    if (next === text) return 'unchanged';
    await writeFileAtomic(fs, root, README, next);
    return 'replaced';
  }
  const separator = text.endsWith('\n') ? '\n' : '\n\n';
  await writeFileAtomic(fs, root, README, `${text}${separator}${wrapped}\n`);
  return 'appended';
}

/** The README block: a short, human-facing summary, not a second index. */
export function renderReadmeBlock(context) {
  const { state, modules, stats, risks } = context;
  const lines = [];
  lines.push('## 项目索引（dsh-ai-indexer 自动生成）');
  lines.push('');
  // Deliberately no scan counter and no timestamp: this block is written into a
  // file that the plugin also scans, so any volatile field here would make every
  // scan rewrite the README, which would then look like a change on the next
  // scan -- an infinite loop that never lets the cache settle.
  lines.push(`指纹 \`${state.hash}\`　模块 ${stats.modules} 个　源文件 ${stats.files} 个`);
  lines.push('');
  lines.push(progressBar(stats.statuses) || '（暂无状态标记）');
  const active = [...modules.values()]
    .filter((module) => module.effectiveStatus === 'wip' || module.effectiveStatus === 'blocked')
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .slice(0, 10);
  if (active.length > 0) {
    lines.push('');
    lines.push('进行中：');
    for (const module of active) lines.push(`- \`${module.id}\`（${module.files.length} 个文件）`);
  }
  const actionable = risks.filter((risk) => risk.severity !== 'info').slice(0, 8);
  if (actionable.length > 0) {
    lines.push('');
    lines.push('待处理告警：');
    for (const risk of actionable) lines.push(`- [${risk.kind}] ${risk.module ? `\`${risk.module}\` ` : ''}${risk.message}`);
  }
  lines.push('');
  lines.push('索引细节见 `.ai-index/master.md`，对话用快照见 `.ai-index/snapshot.md`。');
  return lines.join('\n');
}

/** Deterministic JSON: sorted keys, so an unchanged state is byte-identical. */
export function stableJson(value) {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}
