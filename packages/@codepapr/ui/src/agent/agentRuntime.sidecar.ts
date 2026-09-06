import { createSidecarFetch } from './sidecarFetch';
import { startAgentRuntime } from './agentRuntimeLoop';
import { createHarnessMediator } from './headlessHarness';
import type { AgentWorkerToMainMessage, MainToAgentWorkerMessage } from './agentWorkerProtocol';

// stdout 是 sidecar NDJSON 协议，log/info 必须改走 stderr。
// eslint-disable-next-line no-console
console.log = (...args: unknown[]) => {
  console.error(...args);
};
// eslint-disable-next-line no-console
console.info = (...args: unknown[]) => {
  console.error(...args);
};
console.warn = (...args: unknown[]) => {
  console.error(...args);
};

function rawWriteFrame(message: AgentWorkerToMainMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const subscribers: Array<(message: MainToAgentWorkerMessage) => void> = [];

/**
 * Harness mediator：把外部 CLI/评测机的 harness/* 帧翻译成与桌面同构的
 * init/chat 帧喂给同一个 Agent 循环，并就地应答 UI-bound 工具。
 * 未收到 harness/init 前对两种方向完全透传（桌面路径零变化）。
 */
const harnessMediator = createHarnessMediator({
  deliverToLoop: (message) => {
    for (const subscriber of subscribers) {
      subscriber(message);
    }
  },
  emit: rawWriteFrame,
});

function writeFrame(message: AgentWorkerToMainMessage): void {
  for (const outgoing of harnessMediator.handleOutgoing(message)) {
    rawWriteFrame(outgoing);
  }
}

startAgentRuntime({
  postMessage: writeFrame,
  subscribe: (handler) => {
    subscribers.push(handler);
  },
  fetch: createSidecarFetch(globalThis.fetch.bind(globalThis)),
  installFatalHandlers: (report) => {
    process.on('uncaughtException', (error) => {
      report(
        `Uncaught exception: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    });
    process.on('unhandledRejection', (reason) => {
      report(
        `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
        reason instanceof Error ? reason.stack : undefined,
      );
    });
  },
});

process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) {
      try {
        const message = JSON.parse(line) as MainToAgentWorkerMessage;
        if (!harnessMediator.handleInbound(message)) {
          for (const subscriber of subscribers) {
            subscriber(message);
          }
        }
      } catch (error) {
        writeFrame({
          type: 'worker-diagnostic',
          message: `sidecar NDJSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    newline = buffer.indexOf('\n');
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});
