/**
 * Model building: turn per-file observations into modules, risks, change slices.
 *
 * Two ideas carry the whole design:
 *
 * 1. **Source markers win.** Anything the index says about a module is derived
 *    from the source's `@ai:` comments, so there is exactly one place to edit
 *    and no second copy to drift.
 * 2. **A marker-less tree still indexes.** Files with no `@ai:module` collapse
 *    into their directory, so a first scan of an unmarked repository is still
 *    useful.
 *
 * @module dsh-ai-indexer/indexer
 */
import path from 'node:path';
import {
  contractNames,
  directoryModule,
  firstOf,
  listOf,
} from './markers.js';

const STATUS_VALUES = new Set(['done', 'wip', 'deprecated', 'frozen', 'planned', 'blocked', 'unknown']);

/**
 * Fold file observations into module records.
 *
 * @param files - per-path analysis records.
 * @param options - merged scan options (`moduleDepth`).
 * @returns module map keyed by module id.
 */
export function buildModules(files, options = {}) {
  const moduleDepth = Number.isFinite(options.moduleDepth) ? options.moduleDepth : 2;
  const modules = new Map();

  const ensure = (id) => {
    let module = modules.get(id);
    if (!module) {
      module = {
        id,
        marker: false,
        files: [],
        symbols: new Set(),
        deps: new Set(),
        declaredDeps: new Set(),
        declaredDepDirs: new Map(),
        contracts: [],
        risks: [],
        notes: [],
        refs: [],
        ecosystems: new Set(),
        owners: new Set(),
        statuses: new Set(),
        lines: 0,
        pending: 0,
        bytes: 0,
      };
      modules.set(id, module);
    }
    return module;
  };

  const paths = Object.keys(files).sort();
  for (const rel of paths) {
    const file = files[rel];
    const markers = file.markers ?? {};
    const declared = listOf(markers, 'module');
    const ids = declared.length > 0 ? declared : [directoryModule(rel, moduleDepth)];

    for (const id of ids) {
      const module = ensure(id);
      if (declared.length > 0) module.marker = true;
      module.files.push(rel);
      for (const symbol of file.symbols ?? []) module.symbols.add(symbol);
      for (const dep of file.deps ?? []) module.deps.add(dep);
      for (const dep of listOf(markers, 'deps')) {
        module.declaredDeps.add(dep);
        // A relative dependency only resolves against the file that declared it,
        // so remember which directories claimed this name.
        if (!module.declaredDepDirs.has(dep)) module.declaredDepDirs.set(dep, new Set());
        module.declaredDepDirs.get(dep).add(dirOf(rel));
      }
      for (const contract of markers.contract ?? []) if (contract.length > 0) module.contracts.push({ rel, text: contract });
      for (const risk of listOf(markers, 'risk')) module.risks.push({ rel, text: risk });
      for (const note of listOf(markers, 'note')) module.notes.push({ rel, text: note });
      for (const ref of listOf(markers, 'ref')) module.refs.push({ rel, text: ref });
      for (const eco of listOf(markers, 'ecosystem')) module.ecosystems.add(eco);
      for (const owner of listOf(markers, 'owner')) module.owners.add(owner);
      const status = firstOf(markers, 'status');
      if (status) module.statuses.add(status.toLowerCase().split(/\s+/)[0]);
      module.lines += file.lines ?? 0;
      module.pending += file.pending ?? 0;
      module.bytes += file.size ?? 0;
    }
  }
  return modules;
}

/** Resolve one module's effective status and flag disagreement. */
export function moduleStatus(module) {
  const values = [...module.statuses];
  if (values.length === 0) return { status: 'unknown', conflict: false };
  const invalid = values.filter((value) => !STATUS_VALUES.has(value));
  const usable = values.filter((value) => STATUS_VALUES.has(value));
  if (usable.length === 0) return { status: unknownStatusFor(values, invalid), conflict: invalid.length > 1 };
  return { status: usable[0], conflict: usable.length > 1 || invalid.length > 0 };
}

function unknownStatusFor(values, invalid) {
  if (invalid.length > 1) return 'unknown';
  return values[0] ?? 'unknown';
}

/** Directory part of a workspace-relative path ('' when the file sits at the root). */
function dirOf(rel) {
  const cut = rel.lastIndexOf('/');
  return cut < 0 ? '' : rel.slice(0, cut);
}

const DEP_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.lua', '.py', '.go', '.rs', '.rb', '.php', '.cs', '.java', '.dart'];

/**
 * Is `dep` a relative path that resolves to nothing among the scanned files?
 *
 * Resolution happens against the declaring file's directory, because `./storage`
 * means something different in every file that writes it.
 */
function missingRelativeDep(dep, fileSet, fromDir = '') {
  if (!dep.startsWith('.')) return false;
  const joined = path.posix.normalize(path.posix.join(fromDir || '.', dep.replace(/\\/g, '/')));
  const cleaned = joined.replace(/\/+$/, '');
  if (cleaned.length <= 1 || cleaned === '.') return false;
  const candidates = [cleaned, ...DEP_EXTENSIONS.map((ext) => `${cleaned}${ext}`)];
  for (const candidate of candidates) {
    if (fileSet.has(candidate)) return false;
    if (fileSet.has(`${candidate}/index.js`) || fileSet.has(`${candidate}/index.ts`)) return false;
    const prefix = `${candidate}/`;
    for (const known of fileSet) if (known.startsWith(prefix)) return false;
  }
  return true;
}

/**
 * Derive the risk panel. Every entry is decidable from the scan alone — nothing
 * here guesses at runtime behaviour.
 *
 * @param modules - module map from {@link buildModules}.
 * @param files - per-path analysis records.
 * @param state - previous scan state (used for orphan and staleness checks).
 * @param options - merged scan options.
 */
export function buildRisks(modules, files, state, options = {}) {
  const risks = [];
  const fileSet = new Set(Object.keys(files));
  const staleScans = Number.isFinite(options.staleScans) ? options.staleScans : 5;
  const scanNumber = Number.isFinite(state?.scan) ? state.scan : 1;
  const previousFiles = state?.files ?? {};
  const previousModules = state?.modules ?? {};

  const push = (risk) => risks.push({ severity: 'info', ...risk });

  // Files the index still knows about but that are gone from disk.
  for (const rel of Object.keys(previousFiles)) {
    if (!fileSet.has(rel)) {
      push({
        severity: 'warn',
        kind: 'orphan',
        module: modules.get(directoryModule(rel, options.moduleDepth ?? 2))?.id ?? null,
        message: `索引中的文件已从磁盘消失：${rel}`,
        evidence: '扫描时未再发现该文件',
      });
    }
  }

  for (const module of modules.values()) {
    const { status, conflict } = moduleStatus(module);
    module.effectiveStatus = status;
    if (conflict) {
      push({
        severity: 'warn',
        kind: 'status-conflict',
        module: module.id,
        message: `模块状态标记互相冲突：${[...module.statuses].join(' / ')}`,
        evidence: module.files.slice(0, 3).join(', '),
      });
    }
    if (status === 'done' && module.pending > 0) {
      push({
        severity: 'warn',
        kind: 'done-with-pending',
        module: module.id,
        message: `标记为 done，但源码里还有 ${module.pending} 处 TODO/FIXME`,
        evidence: module.files.slice(0, 2).join(', '),
      });
    }

    // A contract claims an exported name; the file must contain that name somewhere.
    for (const contract of module.contracts) {
      const claimed = contractNames(contract.text);
      if (claimed.length === 0) {
        push({
          severity: 'info',
          kind: 'contract-unparsed',
          module: module.id,
          message: '契约标记里没有可核对的符号名，无法自动校验',
          evidence: `${contract.rel}: ${contract.text.slice(0, 80)}`,
        });
        continue;
      }
      const missing = claimed.filter((name) => !module.symbols.has(name));
      if (missing.length > 0) {
        push({
          severity: 'warn',
          kind: 'contract-missing',
          module: module.id,
          message: `契约声明了未在模块中发现的符号：${missing.join(', ')}`,
          evidence: `${contract.rel}: ${contract.text.slice(0, 100)}`,
        });
      }
    }

    // Declared dependencies that point at project paths with nothing behind them.
    for (const dep of module.declaredDeps) {
      if (module.symbols.has(dep)) continue;
      if (modules.has(dep)) continue;
      const dirs = module.declaredDepDirs?.get(dep) ?? new Set(['']);
      const unresolved = [...dirs].every((dir) => missingRelativeDep(dep, fileSet, dir));
      if (unresolved) {
        push({
          severity: 'warn',
          kind: 'dep-unknown',
          module: module.id,
          message: `@ai:deps 指向的项目内路径不存在：${dep}`,
          evidence: `模块 ${module.id}`,
        });
      }
    }

    // Staleness is measured in scans, not wall-clock, so it is reproducible offline.
    const recorded = previousModules[module.id];
    const lastSeen = recorded?.lastSeenScan ?? scanNumber;
    const lastChanged = recorded?.lastChangedScan ?? scanNumber;
    if (scanNumber - lastChanged >= staleScans) {
      push({
        severity: 'info',
        kind: 'stale',
        module: module.id,
        message: `已连续 ${scanNumber - lastChanged} 次扫描没有变化，建议复核是否还需保留在快照里`,
        evidence: `上次变化：第 ${lastChanged} 次扫描`,
      });
    }
    if (scanNumber - lastSeen >= staleScans) {
      push({
        severity: 'info',
        kind: 'reappeared',
        module: module.id,
        message: '该模块长时间未出现在扫描结果中，本次重新出现',
        evidence: `上次出现：第 ${lastSeen} 次扫描`,
      });
    }
  }

  return risks;
}

/**
 * Change slices: what this scan saw differ from the previous one.
 *
 * Derived locally instead of from session history, so the slice list is
 * available in a fresh session with no conversation to mine.
 */
export function buildChanges(files, state, limit = 20) {
  const previous = state?.files ?? {};
  const changes = [];
  for (const rel of Object.keys(files).sort()) {
    const next = files[rel];
    const before = previous[rel];
    if (!before) {
      changes.push({ rel, kind: 'added', detail: `${next.lines ?? 0} 行` });
    } else if (before.hash !== next.hash) {
      changes.push({ rel, kind: 'changed', detail: `${before.lines ?? 0} → ${next.lines ?? 0} 行` });
    }
  }
  for (const rel of Object.keys(previous).sort()) {
    if (!files[rel]) changes.push({ rel, kind: 'removed', detail: '' });
  }
  const previousSlices = Array.isArray(state?.changes) ? state.changes : [];
  const merged = [...changes.map((c) => ({ ...c, scan: (state?.scan ?? 0) + 1 })), ...previousSlices];
  const seen = new Set();
  const out = [];
  for (const slice of merged) {
    const key = `${slice.scan}:${slice.rel}:${slice.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(slice);
    if (out.length >= limit) break;
  }
  return out;
}

/** Module ids that should leave the snapshot because they are archived or frozen. */
export function isArchived(module) {
  return module.effectiveStatus === 'deprecated' || module.effectiveStatus === 'frozen';
}

/**
 * Aggregate per-module scan facts into the small numbers the UI and the
 * snapshot header show.
 */
export function summarize(modules, files, risks) {
  const counts = { done: 0, wip: 0, planned: 0, blocked: 0, deprecated: 0, frozen: 0, unknown: 0 };
  let marked = 0;
  let pending = 0;
  for (const module of modules.values()) {
    const status = module.effectiveStatus ?? 'unknown';
    counts[status] = (counts[status] ?? 0) + 1;
    if (module.marker) marked += 1;
    pending += module.pending;
  }
  const bySeverity = { error: 0, warn: 0, info: 0 };
  for (const risk of risks) bySeverity[risk.severity] = (bySeverity[risk.severity] ?? 0) + 1;
  return {
    modules: modules.size,
    markedModules: marked,
    files: Object.keys(files).length,
    pending,
    statuses: counts,
    risks: bySeverity,
  };
}
