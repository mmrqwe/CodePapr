import { createSidecarFetch } from './sidecarFetch';
import { startAgentRuntime } from './agentRuntimeLoop';
import type { AgentWorkerToMainMessage, MainToAgentWorkerMessage } from './agentWorkerProtocol';

console.log = (...args: unknown[]) => {
  console.error(...args);
};
console.info = (...args: unknown[]) => {
  console.error(...args);
};
console.warn = (...args: unknown[]) => {
  console.error(...args);
};

function writeFrame(message: AgentWorkerToMainMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const subscribers: Array<(message: MainToAgentWorkerMessage) => void> = [];

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
        for (const subscriber of subscribers) {
          subscriber(message);
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
