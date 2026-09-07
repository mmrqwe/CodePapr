#!/usr/bin/env node
/**
 * L2 单场景执行器：真实 codepapr-cli → 真实 codepapr-server → 真实 Rust
 * 托管工具（read/write/edit/patch/grep/bash/git/diagnostics）+ 真实模型。
 *
 * 与 harness-smoke 同一套驱动方式，区别只在 provider：这里不打 mock，
 * CLI 从真实 HOME 的 ui.settings 解析模型与密钥（本文件永不传 apiKey，
 * 也绝不清印 argv/env），因此测的是模型面对【生产错误文案】的恢复行为。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redact } from './models.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function binPath(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  return process.env[`CODEPAPR_${name.toUpperCase().replace(/-/g, '_')}_BIN`]
    ?? path.join(repoRoot, 'target', 'debug', exe);
}

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

/** 拒绝拿陈旧二进制评估（与 harness-smoke 同一守卫，防止"测了个寂寞"）。 */
export function ensureBins() {
  const srcMtime = newestSourceMtime(path.join(repoRoot, 'crates'));
  for (const name of ['codepapr-cli', 'codepapr-server']) {
    const p = binPath(name);
    if (!fs.existsSync(p)) {
      throw new Error(`缺少 ${name} 二进制（${p}）；先跑 cargo build -p codepapr-cli -p codepapr-server`);
    }
    if (fs.statSync(p).mtimeMs + 1000 < srcMtime) {
      throw new Error(`${p} 比 crates/ 源码旧；先跑 cargo build -p codepapr-cli -p codepapr-server`);
    }
  }
}

/** 在工作区内按映射写文件（自动建目录）。 */
export function writeFiles(workspace, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(workspace, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

export function makeWorkspace(prefix = 'eval') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `codepapr-eval-${prefix}-`));
}

/** 轻量 git 仓库 fixture（dangerous/patch 场景用）。 */
export function initGitRepo(workspace) {
  const run = (args) => {
    const res = spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${res.stderr}`);
  };
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'eval@codepapr.local']);
  run(['config', 'user.name', 'CodePapr Eval']);
}

export function gitStatusPorcelain(workspace) {
  const res = spawnSync('git', ['-C', workspace, 'status', '--porcelain'], { encoding: 'utf8' });
  return res.stdout ?? '';
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { type: 'parse-error', raw: line.slice(0, 400) };
      }
    });
}

/**
 * 跑一个场景。model 为 null 时走 CLI 的 DB 解析（真实用户当前模型）。
 * yolo=false（默认）保持最小权限：外部路径/高危命令都会走到确认通道。
 */
export async function runCase({
  scenario,
  files,
  prompt,
  model = null,
  yolo = false,
  timeoutMs = 180_000,
  gitRepo = false,
  setup = null,
  keepWorkspace = false,
}) {
  ensureBins();
  const workspace = makeWorkspace(scenario);
  writeFiles(workspace, files);
  if (gitRepo) {
    initGitRepo(workspace);
    const run = (args) => spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8' });
    run(['add', '-A']);
    run(['commit', '-q', '-m', 'eval base']);
  }
  // setup 在（可选的）git commit 之后运行：用于制造"未提交改动"等基线态。
  if (setup) {
    setup({
      workspace,
      writeFile: (rel, content) => {
        const full = path.join(workspace, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
      },
      git: (args) => spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }),
    });
  }
  const eventsFile = path.join(workspace, '.eval-events.jsonl');
  const sessionId = `eval-${scenario}-${Date.now().toString(36)}`;
  const args = [
    '-C', workspace,
    'run', '--mode', 'agent',
    '--session-id', sessionId,
    ...(yolo ? ['--yolo'] : []),
    ...(model
      ? ['-p', model.provider, '-m', model.model, '--base-url', model.baseUrl]
      : []),
    '--timeout-ms', String(timeoutMs),
    '--events-jsonl', eventsFile,
    prompt,
  ];
  const started = Date.now();
  // 使用真实 HOME：thinking/tool 等桌面设置必须与用户模型一致（隔离 HOME 会回到
  // stock defaults，opencode 端点会直接 400 unknown parameter `thinking`）。
  // 危险命令门控不依赖 HOME——CLI run 不带 --yolo 时对 permission-request 默认拒绝。
  let stderr = '';
  const exitCode = await new Promise((resolve) => {
    const child = spawn(binPath('codepapr-cli'), args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CODEPAPR_SERVER_BIN: binPath('codepapr-server') },
    });
    child.stdout.resume();
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 60_000);
    child.on('close', (code) => { clearTimeout(killer); resolve(code ?? -1); });
  });
  const events = readJsonl(eventsFile);
  const after = {};
  for (const rel of Object.keys(files)) {
    const full = path.join(workspace, rel);
    after[rel] = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
  }
  const elapsedMs = Date.now() - started;
  if (!keepWorkspace) {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  return {
    scenario,
    exitCode,
    events,
    before: files,
    after,
    elapsedMs,
    workspace: keepWorkspace ? workspace : undefined,
    // CLI stderr 可能回显 provider 配置：返回前一律脱敏
    stderr: redact(stderr, model ? [model] : []),
  };
}
