/**
 * End-to-end smoke test for the host half.
 *
 * It builds a throwaway fixture repository, wires a minimal stand-in for the
 * host services the plugin injects, then drives the real tools, commands and
 * routes. Run it after changing anything under lib/:
 *
 *   node scripts/smoke.mjs
 */
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir, stat as statFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const failures = [];
const checks = [];
function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail });
  if (!condition) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// ----------------------------------------------------------------- fs stub --

function makeFsStub() {
  const target = (p) => ({ targetKey: p, displayPath: p });
  const code = (message, value) => {
    const error = new Error(message);
    error.code = value;
    return error;
  };
  return {
    async resolve(p, opts = {}) {
      const base = opts.cwd ?? process.cwd();
      return target(path.resolve(base, p));
    },
    async stat(t) {
      try {
        const info = await statFile(t.targetKey);
        return {
          version: `${info.mtimeMs}:${info.size}`,
          type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
          size: info.size,
        };
      } catch {
        return undefined;
      }
    },
    async listDir(t) {
      const entries = await readdir(t.targetKey, { withFileTypes: true });
      const out = [];
      for (const entry of entries) {
        const full = path.join(t.targetKey, entry.name);
        if (entry.isDirectory()) {
          out.push({ name: entry.name, type: 'directory', target: target(full) });
        } else if (entry.isFile()) {
          const info = await statFile(full);
          out.push({
            name: entry.name,
            type: 'file',
            target: target(full),
            version: `${info.mtimeMs}:${info.size}`,
            size: info.size,
          });
        }
      }
      return out.sort((a, b) => (a.name < b.name ? -1 : 1));
    },
    async readText(t) {
      return readFile(t.targetKey, 'utf8');
    },
    async writeText(t, content, expected) {
      const info = await statFile(t.targetKey).catch(() => undefined);
      if (!expected) {
        await writeFile(t.targetKey, content, 'utf8');
        return { operation: info ? 'update' : 'create' };
      }
      if (expected.kind === 'createIfAbsent') {
        if (info) throw code('FS_EXISTS: file already exists', 'FS_EXISTS');
        await writeFile(t.targetKey, content, 'utf8');
        return { operation: 'create' };
      }
      if (!info) throw code('FS_STALE_VERSION: missing', 'FS_STALE_VERSION');
      const version = `${info.mtimeMs}:${info.size}`;
      if (version !== expected.version) throw code('FS_STALE_VERSION: moved', 'FS_STALE_VERSION');
      await writeFile(t.targetKey, content, 'utf8');
      return { operation: 'update' };
    },
    async watch() {
      return async () => {};
    },
  };
}

// ----------------------------------------------------------------- fixture --

const FIXTURE = {
  'package.json': JSON.stringify({ name: 'fixture-app', type: 'module' }, null, 2),
  'README.md': '# Fixture App\n\n手写说明，插件不许碰这一段。\n',
  'node_modules/junk/index.js': 'module.exports = 1;\n',
  'src/auth/token.js': `/**
 * @ai:module auth/token
 * @ai:status done
 * @ai:contract 输出:issueToken(userId) verify(token)
 * @ai:deps ./storage
 * @ai:ref jose, jsonwebtoken
 * @ai:ecosystem node, jwt
 */
export function issueToken(userId) { return String(userId); }
export function verify(token) { return token.length > 0; }
function unusedHelper() { return 1; }
`,
  'src/auth/storage.js': `/**
 * @ai:module auth/storage
 * @ai:status wip
 * @ai:contract 输出:saveSession()
 */
export function saveSession(session) { return session; }
// TODO: 换成持久化实现
`,
  'src/ui/panel.js': `/**
 * @ai:module ui/panel
 * @ai:status wip
 * @ai:risk 高分辨率下布局会错位
 */
export function renderPanel() {}
export function resizePanel() {}
export function closePanel() {}
`,
  'scripts/build.py': `"""@ai:module build
@ai:status done
"""
import os

def compile_assets():
    # TODO: 支持增量编译
    return True

class Builder:
    pass
`,
  'src/broken/ghost.js': `/**
 * @ai:module ghost
 * @ai:status done
 * @ai:contract 输出:missingSymbol()
 * @ai:deps ./nowhere
 */
export function ghost() {}
require('./does-not-exist');
`,
  'src/frozen/legacy.lua': `--[[
@ai:module legacy
@ai:status frozen
]]
function LegacyThing() end
`,
};

async function buildFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-indexer-'));
  for (const [rel, content] of Object.entries(FIXTURE)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  return dir;
}

// -------------------------------------------------------------- host stub --

/**
 * Mirror of the host's own assertion: a tool output schema is plain JSON Schema,
 * so `required` is an array of names on an object node and is unsupported on
 * every other type. The real host refuses to activate the plugin when this is
 * violated (`JsonSchemaError: unsupported JSON schema`), so the stub validates
 * it too -- otherwise a schema mistake only shows up after a full install.
 */
function assertSupportedSchema(schema, path = 'schema', seenErrors = []) {
  if (!schema || typeof schema !== 'object') return seenErrors;
  if (Object.prototype.hasOwnProperty.call(schema, 'required')) {
    if (schema.type !== 'object') {
      seenErrors.push(`${path}.required is not supported on type "${schema.type}"`);
    } else if (schema.required === true || schema.required === false) {
      seenErrors.push(`${path}.required must be an array of property names`);
    } else if (Array.isArray(schema.required) && schema.required.some((name) => typeof name !== 'string')) {
      seenErrors.push(`${path}.required must be an array of property names`);
    }
  }
  if (schema.properties) {
    for (const [key, node] of Object.entries(schema.properties)) {
      assertSupportedSchema(node, `${path}.properties.${key}`, seenErrors);
    }
  }
  if (schema.items) assertSupportedSchema(schema.items, `${path}.items`, seenErrors);
  if (Array.isArray(schema.oneOf)) schema.oneOf.forEach((node, index) => assertSupportedSchema(node, `${path}.oneOf[${index}]`, seenErrors));
  return seenErrors;
}

function makeHost(fs, workspace) {
  const tools = new Map();
  const commands = new Map();
  const routes = new Map();
  const contexts = [];
  const answers = [];
  const asked = [];
  const schemaErrors = [];
  const host = {
    tools,
    commands,
    routes,
    contexts,
    answers,
    asked,
    schemaErrors,
    ctx: {
      fs,
      tools: {
        register: (definition) => {
          const errors = assertSupportedSchema(definition.output?.schema, `${definition.name}.output.schema`);
          if (errors.length > 0) throw new Error(`JsonSchemaError: unsupported JSON schema: ${errors.join('; ')}`);
          schemaErrors.push(`${definition.name}: ok`);
          tools.set(definition.name, definition);
          return () => {};
        },
      },
      systemPrompt: { context: (entry) => (contexts.push(entry), () => {}) },
      webServer: { register: (route) => (routes.set(route.path, route), () => {}) },
      commands: { register: (definition) => (commands.set(definition.name, definition), () => {}) },
      userQuestions: {
        ask: async (request) => {
          asked.push(request);
          const replies = request.questions.map((question, index) => {
            const pick = question.options && question.options.length > 1 ? question.options[1] : question.options && question.options[0];
            answers.push({ id: question.id, selected: pick ? [pick.label] : [] });
            return { id: question.id, selected: pick ? [pick.label] : [] };
          });
          return { answers: replies };
        },
      },
      workspaceRegistry: { list: () => [{ path: workspace }] },
      timer: { debounce: (fn) => fn, timeout: () => () => {} },
    },
  };
  return host;
}

// ------------------------------------------------------------------- run --

const workspace = await buildFixture();
const fs = makeFsStub();
const host = makeHost(fs, workspace);
const { apply } = await import('../lib/index.js');
apply(host.ctx, {});
await new Promise((resolve) => setTimeout(resolve, 50));

// 1. tools registered
for (const tool of ['ai_index_scan', 'ai_index_query', 'ai_index_review', 'ai_index_wheel']) {
  check(`tool ${tool} registered`, host.tools.has(tool));
}
check('command ai-index registered', host.commands.has('ai-index'));
check('routes registered', host.routes.has('/ai-indexer/api/state') && host.routes.has('/ai-indexer/api/scan'));
check('prompt context registered', host.contexts.some((entry) => entry.name === 'ai_index_snapshot'));
check('every tool output schema passed the host schema guard', host.schemaErrors.length === 4, host.schemaErrors.join(', '));
check(
  'the schema guard itself still catches the per-field required dialect',
  assertSupportedSchema({ type: 'object', properties: { a: { type: 'string', required: true } } }).length === 1,
);

// 2. scan
const scan = host.tools.get('ai_index_scan');
const scanResult = await scan.execute({});
check('scan reports modules', scanResult.modules >= 5, `modules=${scanResult.modules}`);
check('scan reports files', scanResult.files >= 6, `files=${scanResult.files}`);
check('scan counts marked modules', scanResult.markedModules === 6, `marked=${scanResult.markedModules}`);check('scan fingerprint stable-shape', /^[0-9a-f]{32}$/.test(scanResult.fingerprint), scanResult.fingerprint);
check('scan rendered text', typeof scan.output.render({}, scanResult)[0]?.text === 'string');

// 3. files really written
for (const rel of ['index.json', 'meta.json', 'snapshot.md', 'master.md', 'decisions.json'].filter((f) => f !== 'decisions.json')) {
  check(`.ai-index/${rel} written`, existsSync(path.join(workspace, '.ai-index', rel)));
}
const readme = await readFile(path.join(workspace, 'README.md'), 'utf8');
check('README keeps hand-written prose', readme.includes('手写说明，插件不许碰这一段。'));
check('README gained the sync block', readme.includes('<!-- ai-index:sync -->') && readme.includes('<!-- /ai-index:sync -->'));
check('indexed files exclude node_modules', !existsSync(path.join(workspace, '.ai-index', 'index.json')) || !(await readFile(path.join(workspace, '.ai-index', 'index.json'), 'utf8')).includes('node_modules/junk'));

const snapshot = await readFile(path.join(workspace, '.ai-index', 'snapshot.md'), 'utf8');
check('snapshot has the stable header', snapshot.includes('dsh-ai-indexer:snapshot v1'));
check('snapshot keeps volatile text out of the stable half', snapshot.indexOf('volatile') > snapshot.indexOf('dsh-ai-indexer:end'));

const meta = JSON.parse(await readFile(path.join(workspace, '.ai-index', 'meta.json'), 'utf8'));
check('meta.json created with defaults', meta.snapshotBudgetTokens === 1200 && meta.advisor.enabled === true);

// 4. risks
const index = JSON.parse(await readFile(path.join(workspace, '.ai-index', 'index.json'), 'utf8'));
check('state records per-file hashes', Object.keys(index.files).length >= 6);
check('state records per-module bookkeeping', Boolean(index.modules['auth/token']?.lastSeenScan));
const kinds = new Set(scanResult.risks.map((risk) => risk.kind));
check('risk: contract symbol mismatch detected', kinds.has('contract-missing'), [...kinds].join(','));
check('risk: done + TODO detected', kinds.has('done-with-pending'), '');

// 5. incremental rescan reuses cache
const README_PATH = path.join(workspace, 'README.md');
const readmeA = await readFile(README_PATH, 'utf8');
const rescan1 = await scan.execute({});
const readmeB = await readFile(README_PATH, 'utf8');
const snapA = JSON.parse(await readFile(path.join(workspace, '.ai-index', 'index.json'), 'utf8'));
const rescan2 = await scan.execute({});
const readmeC = await readFile(README_PATH, 'utf8');
const snapB = JSON.parse(await readFile(path.join(workspace, '.ai-index', 'index.json'), 'utf8'));
const reread = Object.keys(snapB.files).filter((rel) => !snapA.files[rel] || snapA.files[rel].v !== snapB.files[rel].v || snapA.files[rel].hash !== snapB.files[rel].hash);
check('rescan reuses the whole cache once the README block settles', rescan2.reused === rescan2.files, `reused=${rescan2.reused} files=${rescan2.files} moved=${reread.join(',') || 'none'}`);
check('the injected snapshot never stops matching the README', readmeA === readmeB && readmeB === readmeC, `same12=${readmeA === readmeB} same23=${readmeB === readmeC}`);
check('fingerprint is stable from the very first scan', scanResult.fingerprint === rescan1.fingerprint && rescan1.fingerprint === rescan2.fingerprint, `${scanResult.fingerprint} / ${rescan1.fingerprint} / ${rescan2.fingerprint}`);
check('rescan keeps the same fingerprint', rescan2.fingerprint === rescan1.fingerprint, `${rescan1.fingerprint} vs ${rescan2.fingerprint}`);
check('first rescan only re-reads the file we wrote', rescan1.reused >= rescan1.files - 1, `reused=${rescan1.reused} files=${rescan1.files}`);

// 6. query
const query = host.tools.get('ai_index_query');
const byModule = await query.execute({ module: 'auth/token' });
check('query finds a module', byModule.hit === 1 && byModule.text.includes('issueToken'), `hit=${byModule.hit}`);
const byKeyword = await query.execute({ keyword: 'jwt' });
check('query matches ecosystem/refs', byKeyword.hit >= 1, `hit=${byKeyword.hit}`);
const noHit = await query.execute({ keyword: 'zzz-definitely-absent' });
check('query reports an honest miss', noHit.hit === 0 && noHit.text.includes('没有匹配项'));

// 7. snapshot injection text
const injected = host.contexts[0].text();
check('snapshot injection is non-empty', injected.length > 100, `${injected.length} chars`);
check('snapshot injection names a real module', injected.includes('auth/token') || injected.includes('ui/panel'));
check('snapshot injection carries usage instructions', injected.includes('ai_index_scan') && injected.includes('ai_index_query'));

// 8. review
const review = host.tools.get('ai_index_review');
const reviewResult = await review.execute({}, { agent: {}, signal: undefined });
check('review asked through the native card', host.asked.length === 1 && host.asked[0].questions.length > 0, `asked=${host.asked.length}`);
check('review status answered', reviewResult.status === 'answered', reviewResult.status);
check('review recorded decisions', reviewResult.recorded > 0, `recorded=${reviewResult.recorded}`);
const decisions = JSON.parse(await readFile(path.join(workspace, '.ai-index', 'decisions.json'), 'utf8'));
check('decisions.json persisted', Array.isArray(decisions.entries) && decisions.entries.length === reviewResult.recorded);
check('review text shows categories', /风险校验|完善补足|拓展探索/.test(reviewResult.text));

// 9. wheel
const wheel = host.tools.get('ai_index_wheel');
const plan = await wheel.execute({ need: '通用配置面板框架', kind: 'generic-infra' });
check('wheel returns a search plan', plan.verdict === 'search' && /建议检索串/.test(plan.text));
check('wheel picks up ecosystem tags', plan.keywords.includes('jwt'), plan.keywords.join(','));
const recorded = await wheel.execute({ need: '通用配置面板框架', kind: 'generic-infra', tier: 'tier2', url: 'https://example.invalid/panel', license: 'MIT' });
check('wheel records a graded result', recorded.verdict === 'recorded');
const cachedAgain = await wheel.execute({ need: '通用配置面板框架', kind: 'generic-infra' });
check('wheel hits its own cache', cachedAgain.verdict === 'cached', cachedAgain.verdict);
const skip = await wheel.execute({ need: '本插件独有的战斗判定', kind: 'project-specific' });
check('wheel skips project-specific work', skip.verdict === 'skip');

// 10. command
const command = await host.commands.get('ai-index').handler({ rawInput: 'status' });
check('command status succeeds', command.kind === 'success' && /指纹/.test(command.text), command.text?.slice(0, 80));
const scanCommand = await host.commands.get('ai-index').handler({ rawInput: 'scan' });
check('command scan succeeds', scanCommand.kind === 'success', scanCommand.text?.slice(0, 80));

// 11. routes
async function callRoute(routePath, method) {
  const captured = { status: 0, body: '' };
  const response = {
    writeHead(status) {
      captured.status = status;
    },
    end(body) {
      captured.body = body ?? '';
    },
  };
  await host.routes.get(routePath).handler({ method, [Symbol.asyncIterator]: async function* () {} }, response);
  return captured;
}
const stateRoute = await callRoute('/ai-indexer/api/state', 'GET');
const payload = JSON.parse(stateRoute.body);
check('state route returns 200', stateRoute.status === 200);
check('state route carries the panel payload', payload.ok === true && Array.isArray(payload.modules) && payload.modules.length > 0);
check('state route carries the marker spec', Array.isArray(payload.markerSpec) && payload.markerSpec.length > 0);
check('state route carries the snapshot preview', payload.snapshotPreview.includes('dsh-ai-indexer:snapshot'));
const methodRoute = await callRoute('/ai-indexer/api/state', 'POST');
check('state route rejects POST', methodRoute.status === 405);
const scanRoute = await callRoute('/ai-indexer/api/scan', 'POST');
check('scan route succeeds', JSON.parse(scanRoute.body).ok === true);

// 12. degraded host: no userQuestions available
{
  const bare = makeHost(makeFsStub(), workspace);
  delete bare.ctx.userQuestions;
  delete bare.ctx.workspaceRegistry;
  const mod = await import('../lib/index.js?bare');
  mod.apply(bare.ctx, { root: workspace });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const bareScan = await bare.tools.get('ai_index_scan').execute({});
  check('plugin works without workspaceRegistry when root is configured', bareScan.modules > 0);
  const bareReview = await bare.tools.get('ai_index_review').execute({}, { agent: {} });
  check('review degrades gracefully without userQuestions', bareReview.status === 'unavailable' && bareReview.text.includes('无法弹出问答卡片'), bareReview.status);
}

// 13. no-marker repository still indexes
{
  const plain = await mkdtemp(path.join(tmpdir(), 'ai-indexer-plain-'));
  await mkdir(path.join(plain, 'lib'), { recursive: true });
  await writeFile(path.join(plain, 'lib', 'a.js'), 'export function alpha() {}\nexport function beta() {}\n', 'utf8');
  await writeFile(path.join(plain, 'lib', 'b.js'), 'export class Gamma {}\n', 'utf8');
  const bare = makeHost(makeFsStub(), plain);
  const mod = await import('../lib/index.js?plain');
  mod.apply(bare.ctx, { root: plain });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const result = await bare.tools.get('ai_index_scan').execute({});
  check('marker-less repo still produces modules', result.modules >= 1, `modules=${result.modules}`);
  check('marker-less repo reports zero marked modules', result.markedModules === 0, `marked=${result.markedModules}`);
}

// 14. budget enforcement
{
  const budget = await mkdtemp(path.join(tmpdir(), 'ai-indexer-budget-'));
  await mkdir(path.join(budget, 'src'), { recursive: true });
  await mkdir(path.join(budget, '.ai-index'), { recursive: true });
  // Hand-written meta: the human owns this file, so the test acts like a human.
  await writeFile(
    path.join(budget, '.ai-index', 'meta.json'),
    JSON.stringify({ version: 1, snapshotBudgetTokens: 300, snapshotModuleLimit: 40, injectSnapshot: true }, null, 2),
    'utf8',
  );
  const chunk = Array.from({ length: 40 }, (_, i) => `export function fn_${i}_${'x'.repeat(20)}() {}`).join('\n');
  for (let i = 0; i < 60; i += 1) {
    await writeFile(path.join(budget, 'src', `mod${i}.js`), `/**\n * @ai:module mod/${i}\n * @ai:status wip\n * @ai:contract 输出:fn_0()\n */\n${chunk}\n`, 'utf8');
  }
  const bare = makeHost(makeFsStub(), budget);
  const mod = await import('../lib/index.js?budget');
  mod.apply(bare.ctx, { root: budget });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bare.tools.get('ai_index_scan').execute({});
  const injected = bare.contexts[0].text();
  const metaText = JSON.parse(await readFile(path.join(budget, '.ai-index', 'meta.json'), 'utf8'));
  const estimate = Math.ceil([...injected].reduce((sum, ch) => sum + (ch.codePointAt(0) > 0x2e80 ? 1.05 : 0.25), 0));
  check('snapshot respects its token budget', estimate <= metaText.snapshotBudgetTokens + 8, `estimate=${estimate} budget=${metaText.snapshotBudgetTokens}`);
  check('the hand-written meta.json is not overwritten', metaText.snapshotBudgetTokens === 300);
  const master = await readFile(path.join(budget, '.ai-index', 'master.md'), 'utf8');
  check('master index keeps every module the snapshot had to drop', master.includes('mod/59') && !injected.includes('mod/59'), `master has mod/59=${master.includes('mod/59')} injected has mod/59=${injected.includes('mod/59')}`);
  check('master index is much larger than the injected snapshot', master.length > injected.length * 3, `master=${master.length} injected=${injected.length}`);
}

// ---------------------------------------------------------------- report --

await rm(workspace, { recursive: true, force: true }).catch(() => {});
for (const entry of checks) console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}${entry.ok || !entry.detail ? '' : `  [${entry.detail}]`}`);
console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`- ${failure}`);
  process.exitCode = 1;
}
