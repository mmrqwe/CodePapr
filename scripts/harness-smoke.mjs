#!/usr/bin/env node
/**
 * End-to-end acceptance smoke for `codepapr run` (CLI 运行时对等方案 §7).
 *
 * Spawns a scripted OpenAI-compatible mock provider, drives the real
 * codepapr-cli binary (which auto-spawns a stdio codepapr-server, which
 * launches the same Node agent sidecar the desktop uses), and asserts:
 *   1. agent mode: read executes via RUST_HOSTED_TOOLS; exit 0; events/result docs complete.
 *   2. ask mode: a hallucinated `write` never touches the filesystem; catalog omitted it.
 *   3. permissions: without --yolo a write is denied -> exit 3, file absent.
 *   4. timeout: --timeout-ms kills with exit 2 and emits run.end(timeout).
 *
 * Prereqs: cargo build -p codepapr-cli -p codepapr-server && npm run build:sidecar -w @codepapr/ui
 * Run: node scripts/harness-smoke.mjs   (from the repo root)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binName = process.platform === 'win32' ? 'codepapr-cli.exe' : 'codepapr-cli';
const cliPath = process.env.CODEPAPR_CLI_BIN ?? path.join(repoRoot, 'target', 'debug', binName);

if (!fs.existsSync(cliPath)) {
  console.error(`missing CLI binary at ${cliPath}; run: cargo build -p codepapr-cli`);
  process.exit(1);
}

// A stale target/debug/codepapr-server silently changes behaviour (observed:
// a fixed once-grant bug re-appeared as regressions against the old binary).
// Refuse to run when Rust sources are newer than the CLI/host binaries.
const serverBinName = process.platform === 'win32' ? 'codepapr-server.exe' : 'codepapr-server';
const serverPath = process.env.CODEPAPR_SERVER_BIN
  ?? path.join(repoRoot, 'target', 'debug', serverBinName);
function newestSourceMtime(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'target' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestSourceMtime(full));
    else if (entry.name.endsWith('.rs')) newest = Math.max(newest, fs.statSync(full).mtimeMs);
  }
  return newest;
}
{
  const srcMtime = newestSourceMtime(path.join(repoRoot, 'crates'));
  for (const [label, binPath] of [['codepapr-cli', cliPath], ['codepapr-server', serverPath]]) {
    if (!fs.existsSync(binPath)) {
      console.error(`missing ${label} binary at ${binPath}; run: cargo build -p codepapr-cli -p codepapr-server`);
      process.exit(1);
    }
    if (fs.statSync(binPath).mtimeMs + 1000 < srcMtime) {
      console.error(`${label} at ${binPath} is older than sources in crates/; run: cargo build -p codepapr-cli -p codepapr-server`);
      process.exit(1);
    }
  }
}

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
};

/** One scripted provider turn. */
function sseToolCall(name, args) {
  return JSON.stringify({
    id: 'gen-mock',
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id: `call-${Math.random().toString(36).slice(2, 8)}`,
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: 'tool_calls',
    }],
  });
}

function sseContent(text) {
  return JSON.stringify({
    id: 'gen-mock',
    choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }],
  });
}

function startMockProvider(turns, delayMs = 0) {
  return new Promise((resolve) => {
    let turn = 0;
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requests.push(JSON.parse(body || '{}'));
        const script = turns[Math.min(turn, turns.length - 1)] ?? sseContent('done');
        turn += 1;
        const send = () => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(`data: ${script}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        };
        if (delayMs > 0 && turn > 1) setTimeout(send, delayMs);
        else if (delayMs > 0 && turn === 1) setTimeout(send, delayMs);
        else send();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/v1`,
        requests,
        close: () => server.close(),
      });
    });
  });
}

function makeWorkspace(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepapr-harness-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function runCli(workspace, extraArgs) {
  return new Promise((resolve) => {
    const child = spawn(cliPath, ['-C', workspace, ...extraArgs], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Isolate the app db (external-access policy, settings) from the real
        // user profile so denial/timeout scenarios stay deterministic.
        HOME: process.env.HOME_FAKE ?? fs.mkdtempSync(path.join(os.tmpdir(), 'codepapr-home-')),
        USERPROFILE: undefined,
        CODEPAPR_SERVER_BIN: process.env.CODEPAPR_SERVER_BIN
          ?? path.join(repoRoot, 'target', 'debug', process.platform === 'win32' ? 'codepapr-server.exe' : 'codepapr-server'),
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function scenarioCompletedRun() {
  const ws = makeWorkspace({ 'a.txt': 'hello-harness' });
  const provider = await startMockProvider([sseToolCall('read', { relativePath: 'a.txt' }), sseContent('read it')]);
  const events = path.join(ws, 'run.jsonl');
  const result = path.join(ws, 'out.json');
  const { code, stderr } = await runCli(ws, [
    'run', '--mode', 'agent', '--yolo',
    '-p', 'openai', '-m', 'mock-model', '--api-key', 'k', '--base-url', provider.url,
    '--timeout-ms', '60000',
    '--events-jsonl', events, '--result-json', result,
    'read a.txt please',
  ]);
  provider.close();
  check('completed run exits 0', code === 0, `code=${code} ${stderr.slice(0, 300)}`);
  const lines = readJsonl(events);
  const types = lines.map((l) => l.type);
  check('events: run.start/tool.start/tool.end/run.end present',
    types.includes('run.start') && types.includes('tool.start') && types.includes('tool.end') && types.includes('run.end'));
  check('events: all lines versioned v1', lines.length > 0 && lines.every((l) => l.v === 1));
  check('events: tool.start carries name+arguments',
    lines.some((l) => l.type === 'tool.start' && l.toolName === 'read' && l.arguments?.relativePath === 'a.txt'));
  check('events: tool.end carries success',
    lines.some((l) => l.type === 'tool.end' && l.toolName === 'read' && l.success === true));
  check('events: run.end reason completed',
    lines.at(-1)?.type === 'run.end' && lines.at(-1)?.exitReason === 'completed');
  if (fs.existsSync(result)) {
    const doc = JSON.parse(fs.readFileSync(result, 'utf8'));
    check('result: finalText + toolCalls + exitReason',
      doc.finalText === 'read it' && doc.toolCalls?.[0]?.name === 'read' && doc.exitReason === 'completed',
      JSON.stringify({ finalText: doc.finalText, toolCalls: doc.toolCalls, exitReason: doc.exitReason }));
    check('result: usage object present (may be zeroed)', typeof doc.usage === 'object');
  } else {
    check('result: result-json written', false);
  }
}

async function scenarioAskCannotWrite() {
  const ws = makeWorkspace({ 'a.txt': 'x' });
  const provider = await startMockProvider([
    sseToolCall('write', { relativePath: 'evil.txt', content: 'pwned' }),
    sseContent('cannot write'),
  ]);
  const { code } = await runCli(ws, [
    'run', '--mode', 'ask', '--yolo',
    '-p', 'openai', '-m', 'mock-model', '--api-key', 'k', '--base-url', provider.url,
    '--timeout-ms', '60000',
    'try to write',
  ]);
  provider.close();
  const wrote = fs.existsSync(path.join(ws, 'evil.txt'));
  check('ask mode: write never lands on disk', !wrote);
  check('ask mode: run still completes (tool error, not crash)', code === 0, `code=${code}`);
}

async function scenarioPermissionDenied() {
  const ws = makeWorkspace({ 'a.txt': 'x' });
  // Workspace-internal writes are governed by the same path policy the
  // desktop sidecar host enforces (auto-approved); permission requests fire
  // for EXTERNAL absolute paths. Exercise the denial path with one.
  const outside = path.join(path.dirname(ws), 'evil-harness-outside.txt');
  const provider = await startMockProvider([
    sseToolCall('write', { relativePath: outside, content: 'pwned' }),
    sseContent('giving up'),
  ]);
  const result = path.join(ws, 'out.json');
  const { code } = await runCli(ws, [
    'run', '--mode', 'agent',
    '-p', 'openai', '-m', 'mock-model', '--api-key', 'k', '--base-url', provider.url,
    '--timeout-ms', '60000', '--result-json', result,
    'write without yolo',
  ]);
  provider.close();
  check('permission denied exits 3', code === 3, `code=${code}`);
  check('permission denied: file not written', !fs.existsSync(outside));
  if (fs.existsSync(result)) {
    const doc = JSON.parse(fs.readFileSync(result, 'utf8'));
    check('permission denied: exitReason=denied', doc.exitReason === 'denied', JSON.stringify(doc.exitReason));
  }
}

async function scenarioAllowlistGrant() {
  const ws = makeWorkspace({ 'a.txt': 'x' });
  const outside = path.join(path.dirname(ws), `evil-grant-${Date.now()}.txt`);
  const provider = await startMockProvider([
    sseToolCall('write', { relativePath: outside, content: 'granted' }),
    sseContent('ok'),
  ]);
  const allowlist = path.join(ws, 'allow.json');
  fs.writeFileSync(allowlist, JSON.stringify([{ tool: 'write', operation: 'write', pathGlob: '**/evil-grant-*' }]));
  const events = path.join(ws, 'run.jsonl');
  const { code } = await runCli(ws, [
    'run', '--mode', 'agent',
    '-p', 'openai', '-m', 'mock-model', '--api-key', 'k', '--base-url', provider.url,
    '--timeout-ms', '60000', '--permission', allowlist,
    '--events-jsonl', events,
    'write outside with grant',
  ]);
  provider.close();
  check('allowlist match grants external write (exit 0)', code === 0, `code=${code}`);
  // Regression: the CLI answers with scope "once"; the host must approve
  // without attempting a persisted grant (directory|file only) and the
  // write must actually land. Exit code alone used to hide the failure.
  const lines = readJsonl(events);
  const grantErrors = lines.filter((l) => l.type === 'tool.end' && l.success === false)
    .map((l) => `${l.toolName}:${l.errorPreview ?? ''}`).join(' | ');
  check('allowlist grant: file really written outside the workspace', fs.existsSync(outside), grantErrors);
  check('allowlist grant: permission approved event recorded',
    lines.some((l) => l.type === 'permission' && l.approved === true));
  check('allowlist grant: write tool.end success',
    lines.some((l) => l.type === 'tool.end' && l.toolName === 'write' && l.success === true), grantErrors);
  try { fs.unlinkSync(outside); } catch { /* ignore */ }
}

async function scenarioYoloExternalWrite() {
  const ws = makeWorkspace({ 'a.txt': 'x' });
  const outside = path.join(path.dirname(ws), `evil-yolo-${Date.now()}.txt`);
  const provider = await startMockProvider([
    sseToolCall('write', { relativePath: outside, content: 'yolo' }),
    sseContent('ok'),
  ]);
  const events = path.join(ws, 'run.jsonl');
  const { code } = await runCli(ws, [
    'run', '--mode', 'agent', '--yolo',
    '-p', 'openai', '-m', 'mock-model', '--api-key', 'k', '--base-url', provider.url,
    '--timeout-ms', '60000', '--events-jsonl', events,
    'write outside with yolo',
  ]);
  provider.close();
  check('--yolo external write exits 0', code === 0, `code=${code}`);
  const yoloLines = readJsonl(events);
  const yoloErrors = yoloLines.filter((l) => l.type === 'tool.end' && l.success === false)
    .map((l) => `${l.toolName}:${l.errorPreview ?? ''}`).join(' | ');
  check('--yolo external write: file really written', fs.existsSync(outside), yoloErrors);
  check('--yolo external write: write tool.end success',
    yoloLines.some((l) => l.type === 'tool.end' && l.toolName === 'write' && l.success === true), yoloErrors);
  try { fs.unlinkSync(outside); } catch { /* ignore */ }
}

async function scenarioSessionIdMultiTurn() {
  const ws = makeWorkspace({ 'a.txt': 'x' });
  const sessionId = `smoke-multi-${Date.now()}`;
  const p1 = await startMockProvider([sseContent('noted: purple banana')]);
  const r1 = await runCli(ws, [
    'run', '--mode', 'agent', '--yolo',
    '-p', 'openai', '-m', 'mock-model', '--api-key', 'k', '--base-url', p1.url,
    '--timeout-ms', '60000', '--session-id', sessionId,
    'remember the passphrase purple banana',
  ]);
  p1.close();
  check('multi-turn: first run exits 0', r1.code === 0, `code=${r1.code} ${r1.stderr.slice(0, 200)}`);

  const p2 = await startMockProvider([sseContent('the passphrase was purple banana')]);
  const r2 = await runCli(ws, [
    'run', '--mode', 'agent', '--yolo',
    '-p', 'openai', '-m', 'mock-model', '--api-key', 'k', '--base-url', p2.url,
    '--timeout-ms', '60000', '--session-id', sessionId,
    'what was the passphrase?',
  ]);
  // Regression: --session-id used to cold-start every invocation. The second
  // run must carry the first run's canonical history into the LLM request.
  const sentBody = p2.requests.length ? JSON.stringify(p2.requests[0]) : '';
  p2.close();
  check('multi-turn: second run exits 0', r2.code === 0, `code=${r2.code}`);
  check('multi-turn: second run request carries first run history',
    sentBody.includes('purple banana') && sentBody.includes('what was the passphrase?'),
    `body=${sentBody.slice(0, 160)}...`);
  check('multi-turn: second run answer reflects history',
    r2.stdout.includes('purple banana'), r2.stdout.slice(0, 120));
}

async function scenarioProvider4xx() {
  const ws = makeWorkspace({ 'a.txt': 'x' });
  let requests = 0;
  const server = await new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      requests += 1;
      req.resume();
      req.on('end', () => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad model' } }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const result = path.join(ws, 'out.json');
  const { code } = await runCli(ws, [
    'run', '--mode', 'agent', '--yolo',
    '-p', 'openai', '-m', 'mock-model', '--api-key', 'k', '--base-url', url,
    '--timeout-ms', '20000', '--result-json', result,
    'this should fail',
  ]);
  server.close();
  check('provider 4xx exits non-zero', code !== 0, `code=${code} requests=${requests}`);
  check('provider 4xx does not hang (retriable=false short-circuits)', requests >= 1 && requests <= 6, `requests=${requests}`);
  if (fs.existsSync(result)) {
    const doc = JSON.parse(fs.readFileSync(result, 'utf8'));
    check('provider 4xx: exitReason=error', doc.exitReason === 'error', JSON.stringify(doc.exitReason));
  }
}

async function scenarioTimeout() {
  const ws = makeWorkspace({ 'a.txt': 'x' });
  const provider = await startMockProvider([sseContent('slow')], 8000);
  const events = path.join(ws, 'run.jsonl');
  const { code } = await runCli(ws, [
    'run', '--mode', 'agent', '--yolo',
    '-p', 'openai', '-m', 'mock-model', '--api-key', 'k', '--base-url', provider.url,
    '--timeout-ms', '1500', '--events-jsonl', events,
    'be slow',
  ]);
  provider.close();
  check('timeout exits 2', code === 2, `code=${code}`);
  const lines = readJsonl(events);
  check('timeout: run.end(timeout) recorded',
    lines.some((l) => l.type === 'run.end' && l.exitReason === 'timeout'));
}

async function scenarioTimeoutDuringTool() {
  const ws = makeWorkspace({ 'a.txt': 'x' });
  // bash sleep starts executing, then the deadline hits mid-tool. The v1
  // protocol promises every started tool still gets an end/cancel line.
  const provider = await startMockProvider([
    sseToolCall('bash', { action: 'run', command: 'sleep 8' }),
    sseContent('never reached'),
  ]);
  const events = path.join(ws, 'run.jsonl');
  const { code } = await runCli(ws, [
    'run', '--mode', 'agent', '--yolo',
    '-p', 'openai', '-m', 'mock-model', '--api-key', 'k', '--base-url', provider.url,
    '--timeout-ms', '2500', '--events-jsonl', events,
    'sleep then time out',
  ]);
  provider.close();
  check('timeout mid-tool exits 2', code === 2, `code=${code}`);
  const lines = readJsonl(events);
  const starts = lines.filter((l) => l.type === 'tool.start').map((l) => l.toolCallId);
  const ends = new Set(lines.filter((l) => l.type === 'tool.end').map((l) => l.toolCallId));
  check('timeout mid-tool: a tool actually started', starts.length === 1, JSON.stringify(starts));
  check('timeout mid-tool: every tool.start has a tool.end/cancel line',
    starts.every((id) => ends.has(id)),
    JSON.stringify({ starts, ends: [...ends] }));
  check('timeout mid-tool: tool.start lines are unique per toolCallId',
    new Set(starts).size === starts.length);
}

async function scenarioToolsPresetMinimal() {
  const ws = makeWorkspace({ 'a.txt': 'x' });
  const provider = await startMockProvider([sseContent('done')]);
  const events = path.join(ws, 'run.jsonl');
  const { code } = await runCli(ws, [
    'run', '--mode', 'agent', '--yolo', '--tools-preset', 'minimal',
    '-p', 'openai', '-m', 'mock-model', '--api-key', 'k', '--base-url', provider.url,
    '--timeout-ms', '60000', '--events-jsonl', events,
    'noop',
  ]);
  provider.close();
  check('minimal preset: run exits 0', code === 0, `code=${code}`);
  const lines = readJsonl(events);
  const runStart = lines.find((l) => l.type === 'run.start');
  const tools = (runStart?.tools ?? []).slice().sort();
  const expected = ['bash', 'edit', 'grep', 'read', 'webfetch', 'websearch', 'write'];
  check('minimal preset: exactly the 7 allowlist tools (no git/lsp/todo/memory/app)',
    JSON.stringify(tools) === JSON.stringify(expected), JSON.stringify(tools));
}

async function scenarioToolsPresetMinimalRejectsNonAllowlist() {
  const ws = makeWorkspace({ 'a.txt': 'x' });
  // Hallucinate `git` (a Rust-hosted tool that exists on the default surface):
  // under minimal the worker never registered it -> must fail as unknown tool,
  // and the run must still complete (tool error, not crash).
  const provider = await startMockProvider([
    sseToolCall('git', { action: 'status' }),
    sseToolCall('read', { relativePath: 'a.txt' }),
    sseContent('recovered'),
  ]);
  const events = path.join(ws, 'run.jsonl');
  const result = path.join(ws, 'out.json');
  const { code } = await runCli(ws, [
    'run', '--mode', 'agent', '--yolo', '--tools-preset', 'minimal',
    '-p', 'openai', '-m', 'mock-model', '--api-key', 'k', '--base-url', provider.url,
    '--timeout-ms', '60000', '--events-jsonl', events, '--result-json', result,
    'git status then read',
  ]);
  provider.close();
  check('minimal + hallucinated git: run completes (exit 0)', code === 0, `code=${code}`);
  const lines = readJsonl(events);
  const gitEnd = lines.find((l) => l.type === 'tool.end' && l.toolName === 'git');
  check('minimal: git call rejected as unknown tool', gitEnd?.success === false, JSON.stringify(gitEnd));
  check('minimal: allowlisted read still works',
    lines.some((l) => l.type === 'tool.end' && l.toolName === 'read' && l.success === true));
}

async function scenarioToolsPresetDefaultSurface() {
  const ws = makeWorkspace({ 'a.txt': 'x' });
  const provider = await startMockProvider([sseContent('done')]);
  const events = path.join(ws, 'run.jsonl');
  await runCli(ws, [
    'run', '--mode', 'agent', '--yolo',
    '-p', 'openai', '-m', 'mock-model', '--api-key', 'k', '--base-url', provider.url,
    '--timeout-ms', '60000', '--events-jsonl', events,
    'noop',
  ]);
  provider.close();
  const lines = readJsonl(events);
  const tools = lines.find((l) => l.type === 'run.start')?.tools ?? [];
  check('default preset: full surface incl. git/lsp/todo (>7)',
    tools.includes('git') && tools.includes('lsp') && tools.includes('todo') && tools.length > 7,
    `count=${tools.length}`);
}

async function scenarioMinimalPromptHygiene() {
  const ws = makeWorkspace({ 'a.txt': 'x' });
  const provider = await startMockProvider([sseContent('done')]);
  await runCli(ws, [
    'run', '--mode', 'agent', '--yolo', '--tools-preset', 'minimal',
    '-p', 'openai', '-m', 'mock-model', '--api-key', 'k', '--base-url', provider.url,
    '--timeout-ms', '60000',
    'noop',
  ]);
  const body = JSON.stringify(provider.requests[0] ?? {});
  provider.close();
  const stale = ['`todo`', '`diagnostics(', '委派 **Explore**', '`question`', 'read/graph/lsp', '[git]', '[lsp]', '[graph]', '[todo]', 'TodoList'];
  const leaks = stale.filter((token) => body.includes(token));
  check('minimal: prompt mentions no removed tools', leaks.length === 0, `leaks=${JSON.stringify(leaks)}`);
  check('minimal: prompt keeps allowed tool guidance', body.includes('[bash]') && body.includes('你处于 Agent 模式'));
  check('minimal: request schema has exactly 7 tools', Array.isArray(provider.requests[0]?.tools) && provider.requests[0].tools.length === 7,
    `tools=${provider.requests[0]?.tools?.map((t) => t.function?.name ?? t.name)?.join(',')}`);
}

async function scenarioDefaultPromptUnchanged() {
  const ws = makeWorkspace({ 'a.txt': 'x' });
  const provider = await startMockProvider([sseContent('done')]);
  await runCli(ws, [
    'run', '--mode', 'agent', '--yolo',
    '-p', 'openai', '-m', 'mock-model', '--api-key', 'k', '--base-url', provider.url,
    '--timeout-ms', '60000',
    'noop',
  ]);
  const body = JSON.stringify(provider.requests[0] ?? {});
  provider.close();
  check('default: prompt still carries full guidance (git/todo/delegation)',
    body.includes('[git]') && body.includes('`todo`') && body.includes('委派 **Explore**'));
}

const scenarios = [
  ['completed run', scenarioCompletedRun],
  ['ask cannot write', scenarioAskCannotWrite],
  ['permission denied', scenarioPermissionDenied],
  ['tools-preset minimal', scenarioToolsPresetMinimal],
  ['tools-preset minimal rejects non-allowlist', scenarioToolsPresetMinimalRejectsNonAllowlist],
  ['tools-preset default surface', scenarioToolsPresetDefaultSurface],
  ['minimal prompt hygiene', scenarioMinimalPromptHygiene],
  ['default prompt unchanged', scenarioDefaultPromptUnchanged],
  ['allowlist grant', scenarioAllowlistGrant],
  ['session-id multi turn', scenarioSessionIdMultiTurn],
  ['yolo external write', scenarioYoloExternalWrite],
  ['provider 4xx', scenarioProvider4xx],
  ['timeout', scenarioTimeout],
  ['timeout mid-tool', scenarioTimeoutDuringTool],
];

for (const [label, scenario] of scenarios) {
  console.log(`\n── ${label} ──`);
  try {
    await scenario();
  } catch (error) {
    check(label, false, String(error?.stack ?? error));
  }
}

console.log(`\nharness-smoke: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`);
process.exit(failures === 0 ? 0 : 1);
