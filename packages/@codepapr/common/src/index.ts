import { sha256 as hashSha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * 提取任意 throw 值的可读错误文本：Error 取 message、字符串原样返回、
 * 其它值 String() 兜底。
 * 注意：Tauri 2 的 invoke 拒绝值就是字符串（Rust Result 的 Err），
 * `(err as Error).message` 对它恒为 undefined——统一用本函数转换。
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

/**
 * SHA256 hash utility
 */
export function sha256(data: string): string {
  return bytesToHex(hashSha256(utf8ToBytes(data)));
}

/**
 * Deep freeze utility - prevents modification at all levels
 */
export function deepFreeze<T>(obj: T): T {
  Object.freeze(obj);

  if (obj && typeof obj === 'object') {
    Object.values(obj).forEach((value) => {
      if (value && typeof value === 'object') {
        deepFreeze(value);
      }
    });
  }

  return obj;
}

/**
 * Deterministic key-sorted JSON serialization
 * Critical for cache consistency
 */
export function sortedStringify(obj: unknown, space = 0): string {
  return JSON.stringify(obj, sortedKeysReplacer, space);
}

function sortedKeysReplacer(key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    Object.keys(value as Record<string, unknown>)
      .sort()
      .forEach((k) => {
        sorted[k] = (value as Record<string, unknown>)[k];
      });
    return sorted;
  }
  return value;
}

/**
 * Generate UUID v4
 */
function formatUuid(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function generateUUID(): string {
  const webCrypto = (globalThis as {
    crypto?: {
      randomUUID?: () => string;
      getRandomValues?: (array: Uint8Array) => Uint8Array;
    };
  }).crypto;

  if (webCrypto?.randomUUID) {
    return webCrypto.randomUUID();
  }

  if (webCrypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    webCrypto.getRandomValues(bytes);
    return formatUuid(bytes);
  }

  throw new Error('Secure random UUID generation is unavailable in this runtime.');
}

/**
 * Logger utility
 *
 * Backwards-compatible API: `new Logger('Prefix')` keeps the original
 * `info / warn / error / debug` methods. Internally each call is now
 * routed through a structured `LogRecord` to one or more sinks.
 *
 * - Level filtering via `Logger.setLevel('warn')` (or `CODEPAPR_LOG_LEVEL` env).
 * - Sink mechanism via `Logger.addSink(...)` for Tauri/file/network collection.
 * - Default sink writes to `console.*` and matches the legacy formatting
 *   (prefix-tagged, with emoji decorations on warn/error/debug).
 *
 * The `process.env.DEBUG` switch is preserved: `debug()` calls are dropped
 * when DEBUG is unset and the runtime level has not explicitly enabled debug.
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export interface LogRecord {
  level: Exclude<LogLevel, 'silent'>;
  prefix: string;
  message: string;
  data?: unknown;
  timestamp: number;
}

export interface LogSink {
  write(record: LogRecord): void;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

function readEnv(name: string): string | undefined {
  const runtimeProcess = (globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  }).process;
  return runtimeProcess?.env?.[name];
}

function detectInitialLevel(): LogLevel {
  const explicit = readEnv('CODEPAPR_LOG_LEVEL')?.toLowerCase() as LogLevel | undefined;
  if (explicit && explicit in LEVEL_RANK) {
    return explicit;
  }
  if (readEnv('DEBUG')) {
    return 'debug';
  }
  return 'info';
}

export const consoleLogSink: LogSink = {
  write(record): void {
    const prefix = `[${record.prefix}]`;
    switch (record.level) {
      case 'error':
        console.error(`${prefix} ❌ ${record.message}`, record.data ?? '');
        return;
      case 'warn':
        console.warn(`${prefix} ⚠️  ${record.message}`, record.data ? record.data : '');
        return;
      case 'debug':
        console.log(`${prefix} 🔍 ${record.message}`, record.data ? record.data : '');
        return;
      case 'info':
      default:
        console.log(`${prefix} ${record.message}`, record.data ? record.data : '');
        return;
    }
  },
};

let currentLevel: LogLevel = detectInitialLevel();
const sinks: LogSink[] = [consoleLogSink];

function dispatch(record: LogRecord): void {
  if (LEVEL_RANK[currentLevel] < LEVEL_RANK[record.level]) {
    return;
  }
  for (const sink of sinks) {
    try {
      sink.write(record);
    } catch {
      // A misbehaving sink must not break the calling code path.
    }
  }
}

export class Logger {
  constructor(private prefix: string) {}

  /** Globally set the minimum level. Records below the threshold are dropped before reaching any sink. */
  static setLevel(level: LogLevel): void {
    currentLevel = level;
  }

  /** Read the current global level (used by tests / diagnostics). */
  static getLevel(): LogLevel {
    return currentLevel;
  }

  /** Register an additional sink (e.g. file writer, Tauri bridge, in-memory ring buffer). */
  static addSink(sink: LogSink): void {
    sinks.push(sink);
  }

  /** Remove a previously registered sink. Returns true if it was present. */
  static removeSink(sink: LogSink): boolean {
    const index = sinks.indexOf(sink);
    if (index === -1) return false;
    sinks.splice(index, 1);
    return true;
  }

  /** Replace all sinks (handy for tests). The default console sink is dropped unless re-added. */
  static setSinks(nextSinks: LogSink[]): void {
    sinks.splice(0, sinks.length, ...nextSinks);
  }

  /** Restore the default sink configuration: just the console sink. */
  static resetSinks(): void {
    sinks.splice(0, sinks.length, consoleLogSink);
  }

  info(message: string, data?: unknown): void {
    dispatch({ level: 'info', prefix: this.prefix, message, data, timestamp: Date.now() });
  }

  warn(message: string, data?: unknown): void {
    dispatch({ level: 'warn', prefix: this.prefix, message, data, timestamp: Date.now() });
  }

  error(message: string, error?: Error | unknown): void {
    dispatch({ level: 'error', prefix: this.prefix, message, data: error, timestamp: Date.now() });
  }

  debug(message: string, data?: unknown): void {
    dispatch({ level: 'debug', prefix: this.prefix, message, data, timestamp: Date.now() });
  }
}

/**
 * Validation utilities
 */
export function isValidMessage(msg: unknown): boolean {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  return (
    typeof m.id === 'string' &&
    typeof m.role === 'string' &&
    ['system', 'user', 'assistant', 'tool'].includes(m.role as string) &&
    typeof m.content === 'string' &&
    typeof m.timestamp === 'number'
  );
}

export * from './git';

export function isValidToolDefinition(tool: unknown): boolean {
  if (!tool || typeof tool !== 'object') return false;
  const t = tool as Record<string, unknown>;
  return (
    typeof t.name === 'string' &&
    typeof t.description === 'string' &&
    typeof t.parameters === 'object'
  );
}

/**
 * Byte calculation utility
 */
export function getByteLength(str: string): number {
  return new TextEncoder().encode(str).length;
}

/**
 * Token estimation (rough: 1 token ≈ 4 bytes)
 */
export function estimateTokens(content: string): number {
  return Math.ceil(getByteLength(content) / 4);
}

export * from './git';
