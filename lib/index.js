/**
 * dsh-ai-indexer — host half.
 *
 * Responsibilities:
 * - scan a workspace and keep `.ai-index/*` in sync (the only writer of those files);
 * - inject a token-bounded project snapshot into the prompt, optionally;
 * - expose tools so the model can scan, query, review and look for prior art;
 * - serve the browser half over HTTP routes;
 * - never edit source code — `@ai:` markers are the single source of truth.
 *
 * @module dsh-ai-indexer
 */
import { analyzeFiles, describeError, fingerprintOf, walkWorkspace } from './scanner.js';
import { buildChanges, buildModules, buildRisks, summarize } from './indexer.js';
import {
  DEFAULT_META,
  INDEX_DIR,
  MASTER_FILE,
  MARKER_SPEC,
  SNAPSHOT_FILE,
  STATE_FILE,
  loadCache,
  loadMeta,
  loadState,
  mergeMeta,
  renderMaster,
  renderReadmeBlock,
  renderSnapshot,
  renderTree,
  stableJson,
  syncReadme,
  writeFileAtomic,
} from './store.js';
import {
  askWithTimeout,
  buildQuestions,
  collectEvidence,
  decisionRecords,
  loadDecisions,
  mapAnswers,
  appendDecisions,
  renderReview,
} from './advisable.js';

export const name = 'ai-indexer';

/** Host services this plugin needs before `apply` may run. */
export const inject = ['fs', 'tools', 'systemPrompt', 'webServer', 'commands', 'userQuestions', 'workspaceRegistry'];

const ROUTE_BASE = '/ai-indexer/api';
const TOOL_PREFIX = 'ai_index_';
const text = (value) => [{ type: 'text', text: String(value) }];

/**
 * @param ctx - plugin context.
 * @param config - optional overrides; the live configuration lives in
 *   `.ai-index/meta.json`, because that file is meant to be edited by hand.
 */
export function apply(ctx, config = {}) {
  /** In-memory view of the last built index. Everything injection-related reads this. */
  const cache = {
    root: undefined,
    meta: mergeMeta(undefined),
    state: undefined,
    modules: new Map(),
    risks: [],
    changes: [],
    stats: undefined,
    tree: '',
    snapshot: { stable: '', full: '', tokens: 0, included: [] },
    decisions: { v: 1, entries: [] },
    lastScanAt: undefined,
    lastError: undefined,
    scanning: undefined,
    watchDispose: undefined,
  };
  const configuredRoot = typeof config.root === 'string' && config.root.length > 0 ? config.root : undefined;

  // ---------------------------------------------------------------- root ----

  async function defaultRoot() {
    if (configuredRoot) return configuredRoot;
    try {
      const list = ctx.workspaceRegistry?.list?.();
      if (Array.isArray(list) && list.length > 0) {
        const first = list[0];
        const candidate = first?.path ?? first?.root ?? first?.directory ?? first?.folder ?? first?.workspaceRoot;
        if (typeof candidate === 'string' && candidate.length > 0) return candidate;
      }
    } catch (error) {
      cache.lastError = `workspaceRegistry.list 失败：${describeError(error)}`;
    }
    return undefined;
  }

  async function resolveRoot(explicit) {
    const candidate = typeof explicit === 'string' && explicit.length > 0 ? explicit : await defaultRoot();
    if (!candidate) {
      throw new Error(
        'ai-indexer 无法确定工作区：请在调用里传 path，或在插件配置里设 root，或确保宿主已注册 workspace。',
      );
    }
    const base = await defaultRoot();
    const target = await ctx.fs.resolve(candidate, base ? { cwd: base } : undefined);
    const info = await ctx.fs.stat(target);
    if (!info || info.type !== 'directory') throw new Error(`不是有效目录：${target.displayPath}`);
    cache.root = target.displayPath;
    return target.displayPath;
  }

  // --------------------------------------------------------------- scan ----

  function moduleFingerprint(module, files) {
    const parts = module.files.map((rel) => files[rel]?.hash ?? rel).sort();
    return parts.join('|').slice(0, 4096);
  }

  /** Pure rebuild of the whole derived view from a persisted state. No I/O. */
  function rebuild(state, meta) {
    const files = state.files ?? {};
    const modules = buildModules(files, meta);
    const provisional = { ...state };
    const risks = buildRisks(modules, files, provisional, meta);
    const changes = Array.isArray(state.changes) ? state.changes : [];
    const stats = summarize(modules, files, risks);
    const tree = renderTree(Object.keys(files), { maxDepth: 3, maxEntries: 140 });
    const context = { meta, state, modules, risks, changes, stats, workspace: state.workspace ?? cache.root ?? '', tree };
    const snapshot = renderSnapshot(context);
    return { modules, risks, changes, stats, tree, snapshot, context };
  }

  async function loadInto(memory) {
    const root = await resolveRoot(memory.rootArg);
    const { meta, corrupt } = await loadMeta(ctx.fs, root);
    const state = await loadState(ctx.fs, root);
    const decisions = await loadDecisions(ctx.fs, root);
    state.workspace = root;
    Object.assign(cache, {
      meta,
      state,
      decisions,
      metaCorrupt: corrupt,
      modules: undefined,
    });
    const built = rebuild(state, meta);
    Object.assign(cache, {
      modules: built.modules,
      risks: built.risks,
      changes: built.changes,
      stats: built.stats,
      tree: built.tree,
      snapshot: built.snapshot,
      root,
    });
    return built;
  }

  async function runScan({ path: explicit, mode = 'fast' } = {}) {
    const root = await resolveRoot(explicit);
    const { meta } = await loadMeta(ctx.fs, root);
    const fs = ctx.fs;
    const rootTarget = await fs.resolve(root);
    const previous = await loadState(fs, root);
    const walked = await walkWorkspace(fs, rootTarget, meta);
    const analyzed = await analyzeFiles(fs, walked, previous.files ?? {});
    const modules = buildModules(analyzed.files, meta);
    const scanNumber = (Number.isFinite(previous.scan) ? previous.scan : 0) + 1;
    const risks = buildRisks(modules, analyzed.files, { ...previous, scan: scanNumber }, meta);
    const changes = buildChanges(analyzed.files, previous, Number.isFinite(meta.changeSliceLimit) ? meta.changeSliceLimit : 20);
    const hash = fingerprintOf(analyzed.files);

    const modulesState = {};
    for (const module of modules.values()) {
      const fingerprint = moduleFingerprint(module, analyzed.files);
      const before = previous.modules?.[module.id];
      const changed = !before || before.fingerprint !== fingerprint;
      modulesState[module.id] = {
        lastSeenScan: scanNumber,
        lastChangedScan: changed ? scanNumber : before?.lastChangedScan ?? scanNumber,
        fingerprint,
        status: module.effectiveStatus,
      };
    }

    const state = {
      v: 1,
      scan: scanNumber,
      mode,
      hash,
      at: new Date().toISOString(),
      workspace: root,
      dirs: walked.dirCount,
      files: analyzed.files,
      modules: modulesState,
      changes,
      caps: {
        truncatedFiles: walked.truncatedFiles,
        truncatedDepth: walked.truncatedDepth,
        skippedLarge: walked.skippedLarge.length,
        unreadable: walked.unreadable.length,
        maxFiles: meta.maxFiles,
        maxDepth: meta.maxDepth,
      },
    };
    const stats = summarize(modules, analyzed.files, risks);
    const tree = renderTree(Object.keys(analyzed.files), { maxDepth: 3, maxEntries: 140 });
    return { root, meta, state, modules, risks, changes, stats, tree, walked, analyzed, previous };
  }

  async function persist(built) {
    const { root, meta, state, modules, risks, changes, stats, tree } = built;
    const context = { meta, state, modules, risks, changes, stats, workspace: root, tree };
    const snapshot = renderSnapshot(context);
    await writeFileAtomic(ctx.fs, root, STATE_FILE, stableJson(state));
    await writeFileAtomic(ctx.fs, root, MASTER_FILE, renderMaster(context));
    await writeFileAtomic(ctx.fs, root, SNAPSHOT_FILE, snapshot.full);
    const readme = await syncReadme(ctx.fs, root, renderReadmeBlock(context));
    Object.assign(cache, {
      root,
      meta,
      state,
      modules,
      risks,
      changes,
      stats,
      tree,
      snapshot,
      lastScanAt: state.at,
      lastError: undefined,
      readme,
    });
    // A missing meta file is the one file we may create ourselves, and only once.
    await writeFileAtomic(ctx.fs, root, `${INDEX_DIR}/meta.json`, `${JSON.stringify(DEFAULT_META, null, 2)}\n`, 'create-only');
    return { snapshot, readme };
  }

  async function scan(options) {
    if (cache.scanning) return cache.scanning;
    const task = (async () => {
      const built = await runScan(options);
      const persisted = await persist(built);
      return { built, persisted };
    })();
    cache.scanning = task;
    try {
      return await task;
    } catch (error) {
      cache.lastError = describeError(error);
      throw error;
    } finally {
      cache.scanning = undefined;
    }
  }

  // ------------------------------------------------------------- tools ----

  ctx.tools.register({
    name: `${TOOL_PREFIX}scan`,
    description: [
      '扫描工作区并增量更新 AI 项目索引（.ai-index/）。',
      '索引事实来自源码里的 @ai: 标记，本工具不修改任何源码。',
      '改动模块的对外接口、状态或依赖之后调用它，让索引重新与源码一致。',
    ].join('\n'),
    parameters: {
      path: { type: 'string', required: false, description: '要扫描的目录；省略时用插件配置或宿主工作区。' },
      mode: { type: 'string', required: false, enum: ['fast', 'deep'], description: 'fast（默认）只看标记与顶层符号；deep 额外保留契约细节。' },
    },
    output: {
      // Note the dialect: an output schema follows plain JSON Schema, so an
      // object declares `required: [names]` and no property carries `required`.
      // Only `parameters` uses the per-field `required: boolean` form.
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['fingerprint', 'scan', 'modules', 'files', 'markedModules', 'pending', 'read', 'reused', 'risks', 'notes'],
        properties: {
          fingerprint: { type: 'string' },
          scan: { type: 'number' },
          modules: { type: 'number' },
          files: { type: 'number' },
          markedModules: { type: 'number' },
          pending: { type: 'number' },
          read: { type: 'number' },
          reused: { type: 'number' },
          risks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['severity', 'kind', 'message'],
              properties: {
                severity: { type: 'string' },
                kind: { type: 'string' },
                module: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
          notes: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const lines = [
          `索引已更新：指纹 ${value.fingerprint}｜第 ${value.scan} 次扫描｜模块 ${value.modules}（标记 ${value.markedModules}）｜文件 ${value.files}`,
          `本次读取 ${value.read} 个文件，复用缓存 ${value.reused} 个。`,
        ];
        if (value.risks.length > 0) {
          lines.push('', `风险 ${value.risks.length} 条：`);
          for (const risk of value.risks.slice(0, 12)) lines.push(`- [${risk.kind}] ${risk.module ? `${risk.module}：` : ''}${risk.message}`);
        } else {
          lines.push('', '风险面板为空。');
        }
        for (const note of value.notes) lines.push(note);
        return text(lines.join('\n'));
      },
    },
    async execute(args = {}) {
      const { built, persisted } = await scan({ path: args.path, mode: args.mode === 'deep' ? 'deep' : 'fast' });
      const notes = [];
      if (built.state.caps.truncatedFiles) notes.push(`注意：达到 maxFiles=${built.state.caps.maxFiles} 上限，索引不完整。`);
      if (built.state.caps.truncatedDepth) notes.push(`注意：达到 maxDepth=${built.state.caps.maxDepth} 深度上限，索引不完整。`);
      if (built.state.caps.skippedLarge > 0) notes.push(`注意：${built.state.caps.skippedLarge} 个文件超过体积上限被跳过。`);
      notes.push(`快照 ${persisted.snapshot.tokens} tokens（预算 ${built.meta.snapshotBudgetTokens}），README 同步：${persisted.readme}。`);
      return {
        fingerprint: built.state.hash,
        scan: built.state.scan,
        modules: built.stats.modules,
        files: built.stats.files,
        markedModules: built.stats.markedModules,
        pending: built.stats.pending,
        read: built.analyzed.read,
        reused: built.analyzed.reused,
        risks: built.risks.slice(0, 40).map((risk) => ({
          severity: risk.severity,
          kind: risk.kind,
          module: risk.module ?? undefined,
          message: risk.message,
        })),
        notes,
      };
    },
  });

  ctx.tools.register({
    name: `${TOOL_PREFIX}query`,
    description: [
      '查询已建立的项目索引：按模块名或关键词找模块、契约、风险、符号、依赖、参考与生态标签。',
      '先用它，不要为了找东西去全量读源码。索引为空时先调用 ai_index_scan。',
    ].join('\n'),
    parameters: {
      module: { type: 'string', required: false, description: '模块 id，精确匹配。' },
      keyword: { type: 'string', required: false, description: '在模块名、符号、契约、风险、依赖、参考、生态标签里做不区分大小写的包含匹配。' },
      path: { type: 'string', required: false, description: '要查询的工作区；省略时用最近一次扫描的项目。' },
      limit: { type: 'number', required: false, description: '最多返回多少个模块，默认 12。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['hit', 'fingerprint', 'text'],
        properties: {
          hit: { type: 'number' },
          fingerprint: { type: 'string' },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => text(value.text),
    },
    async execute(args = {}) {
      if (!cache.state || (args.path && args.path !== cache.root)) await loadInto({ rootArg: args.path });
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 12;
      const needle = typeof args.keyword === 'string' ? args.keyword.trim().toLowerCase() : '';
      const wanted = typeof args.module === 'string' ? args.module.trim() : '';
      const lines = [];
      let hit = 0;
      for (const module of [...cache.modules.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        if (wanted && module.id !== wanted && !module.id.includes(wanted)) continue;
        if (needle) {
          const haystack = [
            module.id,
            ...module.symbols,
            ...module.contracts.map((c) => `${c.text} ${c.rel}`),
            ...module.risks.map((r) => r.text),
            ...module.declaredDeps,
            ...module.refs.map((r) => r.text),
            ...module.ecosystems,
            ...module.owners,
          ].join('\n').toLowerCase();
          if (!haystack.includes(needle)) continue;
        }
        hit += 1;
        if (lines.length === 0) {
          lines.push(`索引指纹 ${cache.state.hash}｜第 ${cache.state.scan} 次扫描｜匹配 ${'{{HIT}}'} 个模块`, '');
        }
        lines.push(`### ${module.id}　${module.effectiveStatus}`);
        lines.push(`- 文件（${module.files.length}）：${module.files.slice(0, 8).join(', ')}${module.files.length > 8 ? ' …' : ''}`);
        if (module.symbols.size > 0) lines.push(`- 符号：${[...module.symbols].slice(0, 12).join(', ')}`);
        if (module.declaredDeps.size > 0) lines.push(`- 依赖：${[...module.declaredDeps].join(', ')}`);
        for (const contract of module.contracts.slice(0, 3)) lines.push(`- 契约（${contract.rel}）：${contract.text}`);
        for (const risk of module.risks.slice(0, 3)) lines.push(`- 已知风险（${risk.rel}）：${risk.text}`);
        for (const ref of module.refs.slice(0, 3)) lines.push(`- 参考：${ref.text}`);
        if (module.pending > 0) lines.push(`- 未完成标记：${module.pending} 处`);
        lines.push('');
        if (hit >= limit) break;
      }
      const relatedRisks = cache.risks.filter((risk) => risk.severity !== 'info' && (!needle || `${risk.kind} ${risk.module ?? ''} ${risk.message}`.toLowerCase().includes(needle)));
      if (relatedRisks.length > 0) {
        lines.push('### 相关告警');
        for (const risk of relatedRisks.slice(0, 12)) lines.push(`- [${risk.kind}] ${risk.module ? `${risk.module}：` : ''}${risk.message}`);
        lines.push('');
      }
      if (lines.length === 0) {
        lines.push(
          cache.state
            ? `没有匹配项（索引指纹 ${cache.state.hash}，模块 ${cache.modules.size} 个）。试试更短的关键词，或先 ai_index_scan。`
            : '还没有索引。先调用 ai_index_scan。',
        );
      }
      const rendered = lines.join('\n').replace('{{HIT}}', String(hit));
      return { hit, fingerprint: cache.state?.hash ?? '', text: rendered };
    },
  });

  ctx.tools.register({
    name: `${TOOL_PREFIX}review`,
    description: [
      '交付完成后做一次后置复盘：从本次改动与索引事实里挑出最值得确认的问题，用原生问答卡片让你逐条选择。',
      '只在真正完成了代码/方案交付时调用，微小语法修复与纯信息查询不要调用。',
      '本工具不修改源码；结论写入 .ai-index/decisions.json，需要落到源码的标记会一并给出。',
    ].join('\n'),
    parameters: {
      path: { type: 'string', required: false, description: '工作区；省略时用最近一次扫描的项目。' },
      focus: { type: 'string', required: false, description: '本轮交付的主题，用于挑选更相关的问题。' },
      maxQuestions: { type: 'number', required: false, description: '最多问几题，默认取 meta.json 的 advisor.maxQuestions（4）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'asked', 'recorded', 'recordedModules', 'text'],
        properties: {
          status: { type: 'string' },
          asked: { type: 'number' },
          recorded: { type: 'number' },
          recordedModules: { type: 'array', items: { type: 'string' } },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => text(value.text),
    },
    async execute(args = {}, exec = {}) {
      if (!cache.state || (args.path && args.path !== cache.root)) await loadInto({ rootArg: args.path });
      const meta = cache.meta;
      const advisor = meta.advisor ?? {};
      if (advisor.enabled === false) {
        return { status: 'disabled', asked: 0, recorded: 0, recordedModules: [], text: '复盘引导已在 meta.json 里关闭（advisor.enabled = false）。' };
      }
      const context = {
        meta,
        state: cache.state,
        modules: cache.modules,
        risks: cache.risks,
        changes: (cache.changes ?? []).filter((change) => change.scan === cache.state.scan),
        stats: cache.stats,
        workspace: cache.root,
        tree: cache.tree,
      };
      const evidence = collectEvidence({
        ...context,
        changes: context.changes.length > 0 ? context.changes : cache.changes ?? [],
      });
      if (evidence.length === 0) {
        return { status: 'nothing', asked: 0, recorded: 0, recordedModules: [], text: '索引里没有值得追问的项：没有告警，也没有缺契约或缺参考的活跃模块。' };
      }
      const pairs = buildQuestions(evidence, meta, args.maxQuestions);
      const questions = pairs.map((pair) => pair.question);
      const focus = typeof args.focus === 'string' && args.focus.trim().length > 0 ? args.focus.trim().slice(0, 200) : undefined;
      if (focus) questions[0].detail = [questions[0].detail, `本轮交付：${focus}`].filter(Boolean).join('　');

      const result = await askWithTimeout(ctx, {
        agent: exec.agent,
        signal: exec.signal,
        timeoutMs: Number.isFinite(advisor.timeoutMs) ? advisor.timeoutMs : 180000,
        questions,
      });
      const resolved = mapAnswers(pairs, result.answers);
      let recorded = 0;
      const recordedModules = [];
      if (result.status === 'answered') {
        const records = decisionRecords(resolved, cache.state.hash).map((record) => ({ ...record, focus: focus ?? null }));
        recorded = records.length;
        if (records.length > 0) {
          cache.decisions = await appendDecisions(ctx.fs, cache.root, records);
          for (const record of records) if (record.module && !recordedModules.includes(record.module)) recordedModules.push(record.module);
        }
      }
      return {
        status: result.status,
        asked: questions.length,
        recorded,
        recordedModules,
        text: renderReview(result, resolved, pairs),
      };
    },
  });

  ctx.tools.register({
    name: `${TOOL_PREFIX}wheel`,
    description: [
      '在动手自己实现一个通用设施（配置、事件总线、序列化、UI 基类等）之前，先确认有没有现成轮子。',
      '不传 kind 时返回检索计划与已缓存的检索历史；传了 kind/queries/tier/url/license 时把这次结论写入缓存，避免重复检索。',
      '项目专属业务逻辑不要检索，直接写。',
    ].join('\n'),
    parameters: {
      need: { type: 'string', required: true, description: '要解决的功能，一句话描述。' },
      kind: { type: 'string', required: false, enum: ['generic-infra', 'project-specific', 'unknown'], description: '是通用设施还是项目专属逻辑。' },
      queries: { type: 'array', required: false, description: '检索用过的关键词组合。', items: { type: 'string' } },
      tier: { type: 'string', required: false, enum: ['tier1', 'tier2', 'tier3', 'tier4'], description: '结论分级：tier1 可直接复用，tier4 是避坑仓库。' },
      url: { type: 'string', required: false, description: '最有参考价值的项目地址。' },
      license: { type: 'string', required: false, description: '该项目开源协议，用于版权提示。' },
      note: { type: 'string', required: false, description: '一句话结论。' },
      path: { type: 'string', required: false, description: '工作区；省略时用最近一次扫描的项目。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['verdict', 'keywords', 'cached', 'text'],
        properties: {
          verdict: { type: 'string' },
          keywords: { type: 'array', items: { type: 'string' } },
          cached: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['need', 'at'],
              properties: {
                need: { type: 'string' },
                tier: { type: 'string' },
                url: { type: 'string' },
                at: { type: 'string' },
              },
            },
          },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => text(value.text),
    },
    async execute(args = {}) {
      if (!cache.state || (args.path && args.path !== cache.root)) await loadInto({ rootArg: args.path });
      const wheel = cache.meta.wheel ?? {};
      const need = String(args.need ?? '').trim();
      const keywords = new Set();
      for (const module of cache.modules.values()) for (const eco of module.ecosystems) keywords.add(eco);
      for (const module of cache.modules.values()) for (const ref of module.refs.slice(0, 2)) keywords.add(ref.text);
      const keywordList = [...keywords].filter((value) => value.length > 0).slice(0, 10);

      const store = await loadCache(ctx.fs, cache.root);
      const days = Number.isFinite(wheel.cacheDays) ? wheel.cacheDays : 7;
      const cutoff = Date.now() - days * 86400000;
      const entries = Array.isArray(store.entries) ? store.entries.filter((entry) => {
        const at = Date.parse(entry?.at ?? '');
        return Number.isFinite(at) ? at >= cutoff : true;
      }) : [];
      const normalise = (value) => String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
      const cachedForNeed = entries.filter((entry) => normalise(entry.need) === normalise(need));

      const writing = typeof args.tier === 'string' && args.tier.length > 0;
      if (writing) {
        const entry = {
          need,
          kind: args.kind ?? 'unknown',
          queries: Array.isArray(args.queries) ? args.queries.slice(0, 8).map(String) : [],
          tier: args.tier,
          url: typeof args.url === 'string' ? args.url : undefined,
          license: typeof args.license === 'string' ? args.license : undefined,
          note: typeof args.note === 'string' ? args.note.slice(0, 400) : undefined,
          at: new Date().toISOString(),
          fingerprint: cache.state?.hash,
        };
        const next = { v: 1, entries: [...entries.filter((old) => normalise(old.need) !== normalise(need)), entry].slice(-200) };
        await writeFileAtomic(ctx.fs, cache.root, `${INDEX_DIR}/cache.json`, stableJson(next));
        return {
          verdict: 'recorded',
          keywords: keywordList,
          cached: next.entries.slice(-8).reverse().map((item) => ({ need: item.need, tier: item.tier, url: item.url, at: item.at })),
          text: [`已记录 ${args.tier} 结论：${need}`, args.url ? `参考：${args.url}` : '', args.license ? `协议：${args.license}（复制代码前先确认许可条款）` : '', '重复检索同类需求时会直接命中这条缓存。'].filter(Boolean).join('\n'),
        };
      }

      if (wheel.enabled === false) {
        return { verdict: 'disabled', keywords: keywordList, cached: [], text: '轮子检索已在 meta.json 里关闭（wheel.enabled = false）。' };
      }

      if (args.kind === 'project-specific') {
        return {
          verdict: 'skip',
          keywords: keywordList,
          cached: cachedForNeed.map((item) => ({ need: item.need, tier: item.tier, url: item.url, at: item.at })),
          text: '这是项目专属逻辑，检索同类项目只会引入无关参考，直接实现即可。',
        };
      }

      const queries = [
        [need, ...keywordList.slice(0, 3)].filter(Boolean).join(' '),
        `${need} ${keywordList[0] ?? ''} library github`.trim(),
        `${need} alternative open source`.trim(),
      ];
      const lines = [
        cachedForNeed.length > 0 ? `缓存里已有同类结论 ${cachedForNeed.length} 条：` : '缓存里没有同类结论，建议按下面的查询串检索后再回来记录：',
      ];
      for (const item of cachedForNeed) lines.push(`- [${item.tier ?? '未分级'}] ${item.need}${item.url ? ` → ${item.url}` : ''}（${item.at}）`);
      lines.push('', '建议检索串：');
      for (const query of queries) lines.push(`- ${query}`);
      if (keywordList.length > 0) lines.push('', `本项目生态标签：${keywordList.join(', ')}`);
      lines.push(
        '',
        '判断分级后请再调用一次本工具，带上 tier / url / license / note 把结论写入缓存。分级参考：',
        '- tier1 同生态、依赖吻合、许可兼容，可直接复用',
        '- tier2 架构可借鉴，不能直接复制',
        '- tier3 生态不匹配或过于老旧，参考价值低',
        '- tier4 已废弃或已知缺陷，列出来是为了避开',
        '',
        '检索到的代码一律当作参考而非素材：复制前先看它的开源协议。',
      );
      return {
        verdict: cachedForNeed.length > 0 ? 'cached' : 'search',
        keywords: keywordList,
        cached: cachedForNeed.map((item) => ({ need: item.need, tier: item.tier, url: item.url, at: item.at })),
        text: lines.join('\n'),
      };
    },
  });

  // -------------------------------------------------------- injection ----

  ctx.systemPrompt.context({
    name: 'ai_index_snapshot',
    order: Number.isFinite(cache.meta.injectOrder) ? cache.meta.injectOrder : 60,
    text: () => {
      if (cache.meta?.enabled === false || cache.meta?.injectSnapshot === false) return '';
      return cache.snapshot?.stable ?? '';
    },
  });

  // ----------------------------------------------------------- routes ----

  function sendJson(response, status, body) {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    });
    response.end(payload);
  }

  async function readBody(request) {
    let raw = '';
    try {
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 65536) break;
      }
    } catch {
      return undefined;
    }
    if (raw.trim().length === 0) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  function statePayload() {
    const modules = [...cache.modules.values()].map((module) => ({
      id: module.id,
      files: module.files.length,
      fileList: module.files.slice(0, 20),
      status: module.effectiveStatus ?? 'unknown',
      marker: Boolean(module.marker),
      lines: module.lines,
      pending: module.pending,
      symbols: [...module.symbols].slice(0, 20),
      deps: [...module.declaredDeps].slice(0, 20),
      contracts: module.contracts.slice(0, 5).map((contract) => ({ rel: contract.rel, text: contract.text })),
      risks: module.risks.slice(0, 5).map((risk) => ({ rel: risk.rel, text: risk.text })),
      refs: module.refs.slice(0, 5).map((ref) => ({ rel: ref.rel, text: ref.text })),
      ecosystems: [...module.ecosystems],
      owners: [...module.owners],
    })).sort((a, b) => (a.id < b.id ? -1 : 1));
    return {
      ok: true,
      root: cache.root,
      fingerprint: cache.state?.hash ?? undefined,
      scan: cache.state?.scan ?? 0,
      at: cache.state?.at ?? undefined,
      mode: cache.state?.mode ?? 'fast',
      lastScanAt: cache.lastScanAt,
      scanning: Boolean(cache.scanning),
      lastError: cache.lastError,
      metaCorrupt: Boolean(cache.metaCorrupt),
      enabled: cache.meta?.enabled !== false,
      injectSnapshot: cache.meta?.injectSnapshot !== false,
      meta: cache.meta,
      stats: cache.stats ?? { modules: 0, files: 0, markedModules: 0, pending: 0, statuses: {}, risks: {} },
      caps: cache.state?.caps ?? undefined,
      modules,
      risks: cache.risks.slice(0, 200),
      changes: (cache.changes ?? []).slice(0, 40),
      decisions: (cache.decisions?.entries ?? []).slice(-40).reverse(),
      snapshotPreview: cache.snapshot?.stable ?? '',
      snapshotTokens: cache.snapshot?.tokens ?? 0,
      snapshotIncluded: cache.snapshot?.included ?? [],
      markerSpec: MARKER_SPEC,
      indexPath: INDEX_DIR,
    };
  }

  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_BASE}/state`,
    handler: (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end();
        return;
      }
      sendJson(response, 200, statePayload());
    },
  });

  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_BASE}/scan`,
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return;
      }
      const body = (await readBody(request)) ?? {};
      try {
        const pathArg = typeof body.path === 'string' && body.path.length > 0 ? body.path : undefined;
        const { built, persisted } = await scan({ path: pathArg, mode: body.mode === 'deep' ? 'deep' : 'fast' });
        sendJson(response, 200, {
          ok: true,
          fingerprint: built.state.hash,
          scan: built.state.scan,
          modules: built.stats.modules,
          files: built.stats.files,
          risks: built.risks.filter((risk) => risk.severity !== 'info').length,
          snapshotTokens: persisted.snapshot.tokens,
          readme: persisted.readme,
          state: statePayload(),
        });
      } catch (error) {
        sendJson(response, 500, { ok: false, error: describeError(error), state: statePayload() });
      }
    },
  });

  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_BASE}/snapshot`,
    handler: (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end();
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(cache.snapshot?.full ?? '');
    },
  });

  // --------------------------------------------------------- commands ----

  ctx.commands.register({
    name: 'ai-index',
    description: '项目索引：扫描、查看状态、触发复盘',
    input: { hint: '<scan|status|review|open>' },
    handler: async (invocation) => {
      const raw = String(invocation?.rawInput ?? '').trim();
      const verb = (raw.split(/\s+/)[0] ?? '').toLowerCase() || 'status';
      try {
        if (verb === 'scan') {
          const { built, persisted } = await scan({ path: raw.split(/\s+/)[1] });
          return {
            kind: 'success',
            text: [
              `索引已更新：指纹 ${built.state.hash}｜第 ${built.state.scan} 次扫描｜模块 ${built.stats.modules}｜文件 ${built.stats.files}`,
              `告警 ${(built.stats.risks.warn ?? 0)} 条，快照 ${persisted.snapshot.tokens} tokens，README 同步：${persisted.readme}`,
              `文件：${MASTER_FILE}、${SNAPSHOT_FILE}、${STATE_FILE}`,
            ].join('\n'),
          };
        }
        if (!cache.state) await loadInto({});
        if (verb === 'review' || verb === 'open') {
          return {
            kind: 'success',
            text: [
              '复盘引导请让模型调用 ai_index_review：它会把问题做成原生问答卡片。',
              cache.snapshot?.tokens ? `当前快照 ${cache.snapshot.tokens} tokens（预算 ${cache.meta.snapshotBudgetTokens}）。` : '',
              `索引目录：${cache.root ? `${cache.root}/${INDEX_DIR}` : '未确定'}`,
            ].filter(Boolean).join('\n'),
          };
        }
        return {
          kind: 'success',
          text: [
            cache.state
              ? `指纹 ${cache.state.hash}｜第 ${cache.state.scan} 次扫描｜模块 ${cache.stats.modules}（标记 ${cache.stats.markedModules}）｜文件 ${cache.stats.files}`
              : '还没有索引，先执行 /ai-index scan。',
            cache.state ? `告警 ${(cache.stats.risks.warn ?? 0)} 条 · 未完成标记 ${cache.stats.pending} 处 · 快照 ${cache.snapshot?.tokens ?? 0} tokens` : '',
            `用法：/ai-index scan | status | review | open`,
          ].filter(Boolean).join('\n'),
        };
      } catch (error) {
        return { kind: 'error', text: `ai-index 执行失败：${describeError(error)}` };
      }
    },
  });

  // ------------------------------------------------------------ watch ----

  async function startWatch() {
    if (cache.meta?.watch !== true || cache.watchDispose) return;
    try {
      const target = await ctx.fs.resolve(cache.root);
      const controller = new AbortController();
      const debounceMs = Number.isFinite(cache.meta.watchDebounceMs) ? cache.meta.watchDebounceMs : 800;
      const trigger = ctx.timer.debounce(() => {
        scan({}).catch((error) => {
          cache.lastError = describeError(error);
        });
      }, debounceMs);
      const dispose = await ctx.fs.watch(target, () => trigger(), controller.signal);
      cache.watchDispose = async () => {
        controller.abort();
        trigger.dispose?.();
        await dispose();
      };
    } catch (error) {
      cache.lastError = `文件监视不可用，已退回手动扫描：${describeError(error)}`;
      cache.watchDispose = undefined;
    }
  }

  // ------------------------------------------------------------ warmup ----

  const warmup = (async () => {
    try {
      await loadInto({});
      await startWatch();
    } catch (error) {
      cache.lastError = describeError(error);
    }
  })();
  warmup.catch(() => {});

  return { reload: async () => loadInto({}), snapshot: () => cache.snapshot?.stable ?? '' };
}

export { loadCache, loadMeta, loadState, mergeMeta };

export default { name, inject, apply };
