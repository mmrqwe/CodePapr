#!/usr/bin/env node

import { spawn } from 'node:child_process';

const retries = 3;
const baseArgs = ['audit', ...process.argv.slice(2), '--json'];

function runAuditOnce(args) {
  return new Promise((resolve) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const npmExecPath = process.env.npm_execpath;
    const command = npmExecPath ? process.execPath : 'npm';
    const commandArgs = npmExecPath ? [npmExecPath, ...args] : args;

    const child = spawn(command, commandArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    child.on('error', (error) => {
      resolve({
        code: 1,
        stdout: '',
        stderr: error.message,
      });
    });
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

function tryParseJson(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractTotalVulnerabilities(report) {
  const total = report?.metadata?.vulnerabilities?.total;
  if (typeof total === 'number') {
    return total;
  }

  return null;
}

function summarizeVulnerabilities(report) {
  const counts = report?.metadata?.vulnerabilities;
  if (!counts || typeof counts !== 'object') {
    return 'npm audit reported vulnerabilities.';
  }

  const orderedLevels = ['critical', 'high', 'moderate', 'low', 'info'];
  const parts = [];
  for (const level of orderedLevels) {
    const count = counts[level];
    if (typeof count === 'number' && count > 0) {
      parts.push(`${level}:${count}`);
    }
  }

  return parts.length > 0
    ? `npm audit found vulnerabilities (${parts.join(', ')}).`
    : 'npm audit reported vulnerabilities.';
}

function isNetworkFailure(text) {
  return /(audit endpoint returned an error|Client network socket disconnected before secure TLS connection was established|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|network request failed|socket hang up|TLS connection)/i.test(
    text
  );
}

function printAttemptWarning(attempt, total, stderr) {
  const message = stderr.trim() || 'Unknown npm audit network failure';
  console.warn(`[audit] Attempt ${attempt}/${total} failed due to registry/network issue.`);
  console.warn(message);
}

let lastNetworkError = '';

for (let attempt = 1; attempt <= retries; attempt += 1) {
  const result = await runAuditOnce(baseArgs);
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  const report = tryParseJson(result.stdout);

  if (report) {
    const total = extractTotalVulnerabilities(report);
    if (typeof total === 'number') {
      if (total > 0) {
        console.error(summarizeVulnerabilities(report));
        process.exit(1);
      }

      console.log('npm audit passed.');
      process.exit(0);
    }
  }

  if (result.code === 0) {
    console.log(result.stdout.trim() || 'npm audit passed.');
    process.exit(0);
  }

  if (isNetworkFailure(combinedOutput)) {
    lastNetworkError = combinedOutput;
    printAttemptWarning(attempt, retries, result.stderr || result.stdout);
    continue;
  }

  if (result.stdout.trim()) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr.trim()) {
    process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  }
  process.exit(result.code || 1);
}

console.warn('[audit] npm registry audit endpoint remained unavailable after multiple attempts.');
if (lastNetworkError.trim()) {
  console.warn(lastNetworkError.trim());
}
// 审计是发布门禁（verify:ci → audit）的一部分：注册表不可达时静默放行，
// 等于网络波动（或被人为制造的干扰）即可让含已知漏洞依赖的构建通过发布链路。
// 默认按失败处理；确需离线跳过时显式设置 CODEPAPR_AUDIT_SKIP_ON_NETWORK_FAILURE=1。
if (process.env.CODEPAPR_AUDIT_SKIP_ON_NETWORK_FAILURE === '1') {
  console.warn('[audit] CODEPAPR_AUDIT_SKIP_ON_NETWORK_FAILURE=1：显式跳过审计失败，发布检查继续。');
  process.exit(0);
}
console.error('[audit] 审计端点不可达，按失败处理（如需离线跳过，设置 CODEPAPR_AUDIT_SKIP_ON_NETWORK_FAILURE=1）。');
process.exit(1);
