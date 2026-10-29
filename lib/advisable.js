/**
 * Post-review advisor.
 *
 * The advisor is *tool-driven*, not hook-driven, on purpose:
 *
 * - a turn-stopping hook would force one extra model turn on every delivery,
 *   which is exactly the token cost this plugin exists to reduce;
 * - the native question card is reached through `ctx.userQuestions`, so nothing
 *   here is invented UI.
 *
 * The plugin never edits source. Answers become an append-only decision log plus
 * a suggested `@ai:` marker line that the model applies through the normal edit
 * path, keeping "the source is the only place a module fact lives" intact.
 *
 * @module dsh-ai-indexer/advisable
 */
import { renderMaster, stableJson, writeFileAtomic, readFileIfPresent, parseJson, INDEX_DIR } from './store.js';

export const DECISIONS_FILE = `${INDEX_DIR}/decisions.json`;

const OPTION_FIX = { label: '现在就做', description: '本轮内直接处理，不需要记入待办' };
const OPTION_LATER = { label: '记入索引待办', description: '写入 .ai-index/decisions.json，下次接手时可见' };
const OPTION_SKIP = { label: '不处理', description: '不写入任何文件' };
const OPTION_INVESTIGATE = { label: '先看同类实现', description: '用 ai_index_wheel 查现成轮子再决定' };

/**
 * Turn index facts into candidate review prompts.
 *
 * Categories are ranked risk > gap > expand and capped by the caller, so an
 * advisory never dumps everything it found.
 *
 * @param context - the same context object the renderers take.
 * @returns ordered candidate items.
 */
export function collectEvidence(context) {
  const { modules, risks, changes } = context;
  const items = [];
  const byId = new Map([...modules.values()].map((module) => [module.id, module]));

  for (const risk of risks) {
    if (risk.severity === 'info') continue;
    const module = risk.module ? byId.get(risk.module) : undefined;
    items.push({
      kind: 'risk',
      key: `risk:${risk.kind}:${risk.module ?? 'project'}`,
      module: risk.module ?? undefined,
      prompt: `${risk.message}${risk.evidence ? `（${risk.evidence}）` : ''}　要怎么处理？`,
      detail: risk.module ? `模块 ${risk.module}` : undefined,
      options: [OPTION_FIX, OPTION_LATER, OPTION_SKIP],
      marker: risk.module && module ? `-- @ai:risk ${risk.message.slice(0, 80)}` : undefined,
    });
  }

  for (const module of modules.values()) {
    if (module.effectiveStatus === 'deprecated' || module.effectiveStatus === 'frozen') continue;
    // A module with exported symbols but no promise about them.
    if (module.contracts.length === 0 && module.symbols.size >= 3) {
      items.push({
        kind: 'gap',
        key: `gap:contract:${module.id}`,
        module: module.id,
        prompt: `\`${module.id}\` 对外暴露了 ${[...module.symbols].slice(0, 3).join('、')} 等符号，但没有写 @ai:contract。要不要补一条接口约定，让下一位接手的人少读一遍源码？`,
        detail: module.files.slice(0, 3).join(', '),
        options: [
          { label: '补契约标记', description: '在模块主文件上加一行 @ai:contract' },
          OPTION_LATER,
          OPTION_SKIP,
        ],
        marker: `-- @ai:contract 输出:${[...module.symbols][0]}() 入参:<描述>`,
      });
    }
    if (module.pending > 0 && module.effectiveStatus === 'wip') {
      items.push({
        kind: 'gap',
        key: `gap:pending:${module.id}`,
        module: module.id,
        prompt: `\`${module.id}\` 仍有 ${module.pending} 处 TODO/FIXME，是否本轮一并收尾？`,
        detail: module.files.slice(0, 2).join(', '),
        options: [OPTION_FIX, OPTION_LATER, OPTION_SKIP],
      });
    }
    if (module.refs.length === 0 && module.symbols.size >= 5) {
      items.push({
        kind: 'expand',
        key: `expand:wheel:${module.id}`,
        module: module.id,
        prompt: `\`${module.id}\` 没有 @ai:ref。这里是不是通用设施？要不要先查一下同类项目怎么做，再决定要不要自己写？`,
        detail: '通用基础设施通常是重复造轮子的高发区；项目专属业务逻辑则不必查。',
        options: [OPTION_INVESTIGATE, OPTION_LATER, OPTION_SKIP],
      });
    }
  }

  if (changes.length >= 6) {
    items.push({
      kind: 'expand',
      key: 'expand:slice',
      prompt: `本轮涉及 ${changes.length} 个文件，改动面偏大。是否需要我按模块拆一次变更说明，放进索引的变更切片里？`,
      options: [OPTION_FIX, OPTION_LATER, OPTION_SKIP],
    });
  }

  const severity = { risk: 0, gap: 1, expand: 2 };
  return items.sort((a, b) => (severity[a.kind] ?? 9) - (severity[b.kind] ?? 9));
}

/**
 * Shape candidates into native question items.
 *
 * @param items - candidates from {@link collectEvidence}.
 * @param meta - merged meta (`advisor.priority`, `advisor.maxQuestions`).
 * @param overrideMax - explicit cap from the tool call.
 */
export function buildQuestions(items, meta, overrideMax) {
  const advisor = meta.advisor ?? {};
  const configured = Number.isFinite(overrideMax) ? overrideMax : advisor.maxQuestions ?? 4;
  const max = Math.max(1, Math.min(6, Math.floor(configured)));
  const priority = Array.isArray(advisor.priority) && advisor.priority.length > 0 ? advisor.priority : ['risk', 'gap', 'expand'];
  const order = new Map(priority.map((kind, index) => [kind, index]));
  const ranked = [...items].sort((a, b) => (order.get(a.kind) ?? 9) - (order.get(b.kind) ?? 9));
  const chosen = [];
  const perKind = new Map();
  for (const item of ranked) {
    const used = perKind.get(item.kind) ?? 0;
    if (used >= 2) continue;
    perKind.set(item.kind, used + 1);
    chosen.push(item);
    if (chosen.length >= max) break;
  }
  return chosen.map((item, index) => ({
    item,
    question: {
      id: `ai-${index + 1}-${item.kind}`,
      header: item.kind === 'risk' ? '风险校验' : item.kind === 'gap' ? '完善补足' : '拓展探索',
      question: item.prompt,
      detail: item.detail,
      options: item.options,
    },
  }));
}

/**
 * Ask the user through the native question card, bounded by a timeout.
 *
 * `ask()` blocks until answered, so a timer aborts the wait instead of leaving
 * the turn hanging forever.
 *
 * @returns `{ status, answers? }` where status is answered / timed-out / unavailable / cancelled.
 */
export async function askWithTimeout(ctx, { agent, signal, timeoutMs, questions }) {
  const userQuestions = ctx.userQuestions;
  if (!userQuestions || typeof userQuestions.ask !== 'function') {
    return { status: 'unavailable', reason: '宿主没有 userQuestions 服务' };
  }
  const controller = new AbortController();
  const disposeTimer = typeof ctx.timer?.timeout === 'function'
    ? ctx.timer.timeout(() => controller.abort(new Error('AI_INDEXER_ASK_TIMEOUT')), Math.max(5000, timeoutMs))
    : () => {};
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const answer = await userQuestions.ask({ questions, agent, signal: controller.signal });
    return { status: 'answered', answers: answer };
  } catch (error) {
    const code = String(error?.code ?? '');
    if (code.includes('ASK_ABORTED') || error?.name === 'AbortError') {
      if (signal?.aborted) return { status: 'cancelled' };
      return { status: 'timed-out' };
    }
    if (code.includes('CALLER_NOT_LIVE') || code.includes('DELEGATED_CALLER')) {
      return { status: 'unavailable', reason: '当前会话没有可以直接提问的用户入口' };
    }
    if (code.includes('TIMED_OUT')) return { status: 'timed-out' };
    return { status: 'unavailable', reason: String(error?.message ?? error).slice(0, 200) };
  } finally {
    if (signal) signal.removeEventListener?.('abort', onAbort);
    disposeTimer();
  }
}

/**
 * Fold an answer batch back into the candidate items.
 * @param pairs - output of {@link buildQuestions}.
 * @param answers - `AskUserQuestionAnswer`, or undefined when unanswered.
 */
export function mapAnswers(pairs, answers) {
  const selected = new Map();
  for (const entry of answers?.answers ?? []) {
    if (entry && typeof entry.id === 'string') selected.set(entry.id, entry);
  }
  return pairs.map(({ item, question }) => {
    const answer = selected.get(question.id);
    const choice = answer?.custom && answer.custom.trim().length > 0
      ? answer.custom.trim()
      : (answer?.selected ?? []).join(' / ');
    return { item, question, choice: choice || '' };
  });
}

/** Read the append-only decision log. */
export async function loadDecisions(fs, root) {
  const found = await readFileIfPresent(fs, root, DECISIONS_FILE);
  const parsed = parseJson(found?.text, { v: 1, entries: [] });
  return Array.isArray(parsed?.entries) ? parsed : { v: 1, entries: [] };
}

/** Append answered reviews. Nothing is stored when the user chose "不处理". */
export async function appendDecisions(fs, root, records) {
  const store = await loadDecisions(fs, root);
  const entries = store.entries.slice(-400);
  for (const record of records) entries.push(record);
  const next = { v: 1, entries };
  await writeFileAtomic(fs, root, DECISIONS_FILE, stableJson(next));
  return next;
}

/** Which answered candidates deserve a durable record. */
export function decisionRecords(resolved, fingerprint) {
  const at = new Date().toISOString();
  const out = [];
  for (const entry of resolved) {
    const choice = entry.choice;
    if (!choice || choice.includes('不处理') || choice.includes('skip')) continue;
    out.push({
      at,
      fingerprint,
      kind: entry.item.kind,
      module: entry.item.module ?? null,
      question: entry.question.question,
      choice,
      suggestedMarker: entry.item.marker ?? null,
    });
  }
  return out;
}

/**
 * Render the model-facing summary of a review round.
 *
 * When the interactive card was unavailable the same questions are returned as
 * plain text, so the review still happens instead of silently disappearing.
 */
export function renderReview(result, resolved, questions) {
  const lines = [];
  lines.push('## 后置复盘引导');
  if (result.status === 'answered') lines.push('（已通过原生问答卡片收集结论）');
  else if (result.status === 'timed-out') lines.push('（等待超时，未收到回答；下面是本轮想问的问题）');
  else if (result.status === 'cancelled') lines.push('（提问被取消）');
  else lines.push(`（无法弹出问答卡片：${result.reason ?? '未知原因'}；请直接把下面的问题呈现给用户）`);

  lines.push('');
  const list = resolved.length > 0 ? resolved : questions.map(({ item, question }) => ({ item, question, choice: '' }));
  let lastHeader = '';
  for (const entry of list) {
    const icon = entry.item.kind === 'risk' ? '🚨' : entry.item.kind === 'gap' ? '📌' : '🚀';
    const header = entry.question.header ?? (entry.item.kind === 'risk' ? '风险校验' : entry.item.kind === 'gap' ? '完善补足' : '拓展探索');
    if (header !== lastHeader) {
      lines.push(`**${icon} ${header}**`);
      lastHeader = header;
    }
    lines.push(`- ${entry.question.question}`);
    if (entry.item.module) lines.push(`  模块：\`${entry.item.module}\``);
    if (entry.choice) lines.push(`  → 你的选择：${entry.choice}`);
    if (entry.item.marker) lines.push(`  可写回源码的标记：\`${entry.item.marker.trim()}\``);
  }
  lines.push('');
  lines.push('结论已记入 `.ai-index/decisions.json`（未选"不处理"的项）。索引事实仍以源码里的 `@ai:` 标记为准：需要落到源码的，用上面的标记行改对应文件，然后 `ai_index_scan`。');
  return lines.join('\n');
}

export { renderMaster };
