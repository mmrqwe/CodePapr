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
console.warn('[audit] Skipping audit failure because the endpoint could not be reached; publish checks will continue.');
process.exit(0);
