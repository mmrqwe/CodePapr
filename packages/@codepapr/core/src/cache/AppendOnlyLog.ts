/**
 * AppendOnlyLog: Immutable message history
 *
 * Core invariant: Append-only semantics.
 * - Messages can only be added, never modified or deleted
 * - Each message has an immutable index
 * - Returns frozen copies to prevent external modification
 * - Hash changes only when new messages are added
 */

import {
  IAppendOnlyLog,
  IMessage,
  IAppendLogEntry,
  AppendOnlyViolationError,
} from '@codepapr/types';
import { sha256, deepFreeze, generateUUID } from '@codepapr/common';
import { Serializer } from './Serializer';
import {
  describeLogWireMeta,
  measureLogWireFootprint,
  LogWireMeta,
  LogWireFootprint,
} from '../context/wireShape';
import { Logger } from '@codepapr/common';

const log = new Logger('AppendOnlyLog');

export class AppendOnlyLog implements IAppendOnlyLog {
  private messages: IMessage[] = [];
  private readonly hashes: Map<number, string> = new Map();
  private totalBytes: number = 0;
  /** 与 messages 同下标的 wire 计量（append/loadFromSnapshot 维护，pop 截断）。 */
  private wireMetas: LogWireMeta[] = [];
  private cachedWireFootprint: LogWireFootprint | null = null;
  private lastComputedHash: string = '';
  /** Memoized cascading prefix hash for the longest prefix hashed so far.
   *  Extending a previous computation is then O(delta). Never stale: every
   *  mutation that rewrites history (reset/loadFromSnapshot) or removes a
   *  tail message (popLastMessage) invalidates it. */
  private prefixChainHash = '';
  private prefixChainLen = 0;
  private readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * Append a single message (immutable)
   * Returns the message index
   */
  async append(message: IMessage): Promise<number> {
    // 1. Create normalized, frozen message
    const frozen = this.freezeMessage({
      ...message,
      id: message.id || generateUUID(),
      timestamp: message.timestamp ?? Date.now(),
    });

    // 2. Validate message structure
    if (!this.validateMessage(frozen)) {
      throw new AppendOnlyViolationError(`Invalid message format: ${JSON.stringify(message)}`);
    }

    // 3. Compute message hash (for integrity verification)
    const serialized = Serializer.stringify(frozen);
    const msgHash = sha256(serialized);

    // 4. Store in immutable array
    const index = this.messages.length;
    this.messages.push(frozen);
    this.hashes.set(index, msgHash);

    // 5. Update total bytes + wire 计量（复用同一次序列化）
    const wireMeta = describeLogWireMeta(frozen, serialized);
    this.totalBytes += wireMeta.bytes;
    this.wireMetas.push(wireMeta);
    this.cachedWireFootprint = null;

    // 6. Invalidate cached hash (will be recomputed on next call)
    this.lastComputedHash = '';

    log.debug(`Appended message ${index} (${frozen.role})`, {
      id: frozen.id,
      hash: msgHash,
    });

    return index;
  }

  /**
   * Append multiple messages (batch operation)
   */
  async appendBatch(messages: IMessage[]): Promise<number[]> {
    const indices: number[] = [];
    for (const msg of messages) {
      const idx = await this.append(msg);
      indices.push(idx);
    }
    return indices;
  }

  /**
   * Get message at specific index (returns frozen copy)
   */
  getMessageAt(index: number): IMessage | null {
    if (index < 0 || index >= this.messages.length) {
      return null;
    }

    const msg = this.messages[index]!;
    // Return a frozen deep copy to prevent external modification
    return deepFreeze(JSON.parse(JSON.stringify(msg))) as IMessage;
  }

  /**
   * Get all messages since index (inclusive)
   */
  getMessagesSince(index: number): IMessage[] {
    if (index < 0 || index >= this.messages.length) {
      return [];
    }

    return this.messages
      .slice(index)
      .map((m) => deepFreeze(JSON.parse(JSON.stringify(m))) as IMessage);
  }

  /**
   * Get all messages (read-only)
   */
  getAllMessages(): ReadonlyArray<IMessage> {
    return Object.freeze(
      this.messages.map((m) => deepFreeze(JSON.parse(JSON.stringify(m))) as IMessage)
    );
  }

  /**
   * Get last message
   */
  getLastMessage(): IMessage | null {
    if (this.messages.length === 0) {
      return null;
    }
    return this.getMessageAt(this.messages.length - 1);
  }

  /**
   * Remove and return the last message (RECOVERY ONLY: breaks append-only contract).
   * Used exclusively for image-injection rollback.
   */
  popLastMessage(): IMessage | null {
    if (this.messages.length === 0) {
      return null;
    }
    const index = this.messages.length - 1;
    const msg = this.messages.pop()!;
    this.hashes.delete(index);
    const meta = this.wireMetas.pop();
    this.totalBytes -= meta ? meta.bytes : Serializer.getByteLength(msg);
    this.cachedWireFootprint = null;
    this.lastComputedHash = '';
    if (this.prefixChainLen > this.messages.length) {
      this.prefixChainLen = 0;
      this.prefixChainHash = '';
    }
    return msg;
  }

  /**
   * Get message count
   */
  length(): number {
    return this.messages.length;
  }

  /**
   * Compute hash of entire log (cascading hash)
   * Hash of hash of hash... ensures any modification is detected
   */
  computeHash(): string {
    if (this.lastComputedHash) {
      return this.lastComputedHash;
    }

    let hash = '';
    for (let i = 0; i < this.messages.length; i++) {
      const msgHash = this.hashes.get(i);
      if (!msgHash) {
        throw new AppendOnlyViolationError(`Missing hash for message ${i}`);
      }
      hash = sha256(hash + msgHash);
    }

    this.lastComputedHash = hash;
    return hash;
  }

  /**
   * Compute hash of the prefix containing the first `count` messages.
   * Memoized: extending the longest previously hashed prefix is O(delta),
   * so per-turn verification of a growing log stays cheap (5.0.1).
   */
  computeHashUpTo(count: number): string {
    if (count <= 0) return '';
    if (count > this.messages.length) {
      throw new AppendOnlyViolationError(
        `computeHashUpTo out of range: ${count} > ${this.messages.length}`
      );
    }
    if (count === this.messages.length && this.lastComputedHash) {
      return this.lastComputedHash;
    }

    let base = 0;
    let hash = '';
    if (this.prefixChainLen > 0 && this.prefixChainLen <= count) {
      base = this.prefixChainLen;
      hash = this.prefixChainHash;
    }

    for (let i = base; i < count; i++) {
      const msgHash = this.hashes.get(i);
      if (!msgHash) {
        throw new AppendOnlyViolationError(`Missing hash for message ${i}`);
      }
      hash = sha256(hash + msgHash);
    }

    if (count >= this.prefixChainLen) {
      this.prefixChainLen = count;
      this.prefixChainHash = hash;
    }
    if (count === this.messages.length) {
      this.lastComputedHash = hash;
    }
    return hash;
  }

  /**
   * Truncate the log to its first `count` messages, popping the tail.
   *
   * SANCTIONED break of the append-only invariant, used exclusively by worker
   * log sync reconciliation: a turn cancelled or failed mid-flight leaves a
   * partial tail in the worker's cached log that the main-thread mirror never
   * received; the common prefix is hash-verified before the tail is dropped.
   */
  truncateTo(count: number): void {
    if (count < 0 || count > this.messages.length) {
      throw new AppendOnlyViolationError(
        `truncateTo out of range: ${count} (length ${this.messages.length})`
      );
    }
    while (this.messages.length > count) {
      this.popLastMessage();
    }
  }

  /**
   * Compute hash since specific index
   */
  computeHashSince(index: number): string {
    if (index < 0 || index >= this.messages.length) {
      return '';
    }

    let hash = '';
    for (let i = index; i < this.messages.length; i++) {
      const msgHash = this.hashes.get(i);
      if (!msgHash) {
        throw new AppendOnlyViolationError(`Missing hash for message ${i}`);
      }
      hash = sha256(hash + msgHash);
    }

    return hash;
  }

  /**
   * Get total bytes of all messages
   */
  getContentBytes(): number {
    return this.totalBytes;
  }

  /**
   * Wire footprint：这些消息真正随请求上线时的体量（剥离已消费的图片 base64、
   * 把「最新一批」之外的工具全文按冻结摘要计）。预算决策与缩容有效性判定必须用
   * 这个口径，否则 log 里永久留着的图片 base64 与工具全文会把估算抬高一个数量
   * 级，导致「压缩风暴」：每轮都判定超预算，而压缩看不见超出的部分、永远缩不到
   * 预算以下。图片另按 vision 口径（张数 × 固定权重）单独计费，见 wireShape。
   */
  getWireFootprint(): LogWireFootprint {
    if (this.wireMetas.length !== this.messages.length) {
      // 元数据与消息不同步（理论上不可能：所有改写 messages 的路径都同步改写
      // wireMetas）。宁可重算一遍也不让预算决策用上脏口径。
      log.error('Wire metadata length mismatch - rebuilding', {
        metas: this.wireMetas.length,
        messages: this.messages.length,
      });
      this.wireMetas = this.messages.map((msg) => describeLogWireMeta(msg));
      this.cachedWireFootprint = null;
    }
    if (!this.cachedWireFootprint) {
      this.cachedWireFootprint = measureLogWireFootprint(this.wireMetas);
    }
    return this.cachedWireFootprint;
  }

  /**
   * Validate append-only invariants
   */
  validate(): boolean {
    let cascadingHash = '';
    let recomputedBytes = 0;

    if (this.hashes.size !== this.messages.length) {
      log.error('Hash index count mismatch', {
        hashes: this.hashes.size,
        messages: this.messages.length,
      });
      return false;
    }

    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i]!;

      if (!Object.isFrozen(msg)) {
        log.error('Message not frozen!', { id: msg.id });
        return false;
      }

      if (!this.validateMessage(msg)) {
        log.error('Invalid message format!', { id: msg.id });
        return false;
      }

      const expectedHash = this.hashes.get(i);
      const actualHash = sha256(Serializer.stringify(msg));

      if (!expectedHash) {
        log.error('Missing hash for message index', { i });
        return false;
      }

      if (expectedHash !== actualHash) {
        log.error('Message hash mismatch - log may have been modified!', { i });
        return false;
      }

      recomputedBytes += Serializer.getByteLength(msg);
      cascadingHash = sha256(cascadingHash + actualHash);
    }

    if (recomputedBytes !== this.totalBytes) {
      log.error('Byte count mismatch - log may have been modified!', {
        expected: this.totalBytes,
        actual: recomputedBytes,
      });
      return false;
    }

    if (this.lastComputedHash && this.lastComputedHash !== cascadingHash) {
      log.error('Cascading hash mismatch - log may have been modified!');
      return false;
    }

    return true;
  }

  /**
   * 从 `from` 下标起（含）新增消息的 wire 口径体量。用于 provider 实测对账的
   * 增量部分：实测请求发出后 log 追加了工具结果/图片消息，实测总量 + 这部分
   * 增量仍比纯 heuristic 准得多（heuristic 会把已不上线的图片 base64 计入）。
   */
  getWireFootprintSince(from: number): LogWireFootprint {
    const start = Math.max(0, Math.min(from, this.wireMetas.length));
    return measureLogWireFootprint(this.wireMetas.slice(start));
  }

  /**
   * Convert to message array (for API requests)
   */
  toMessageArray(): IMessage[] {
    return this.messages.map((m) =>
      deepFreeze(JSON.parse(JSON.stringify(m))) as IMessage
    );
  }

  /**
   * Convert to JSON snapshot
   */
  toJSON(): IAppendLogEntry {
    return {
      messages: [...this.messages],
      lastMessageIndex: this.messages.length - 1,
      totalBytes: this.totalBytes,
    };
  }

  /**
   * Create snapshot (for persistence)
   */
  createSnapshot(): IAppendLogEntry {
    return this.toJSON();
  }

  /**
   * Reset the log to empty so a fresh snapshot can be loaded.
   *
   * SANCTIONED break of the append-only invariant, used exclusively by context
   * compaction: when the conversation overflows the context budget, the active
   * history is replaced by a checkpoint summary + retained tail, starting a new
   * "context epoch" (mirrors OpenCode's Context Epoch). Callers must also reset
   * the RequestBuilder's append-only tracking after this.
   */
  reset(): void {
    this.messages = [];
    this.hashes.clear();
    this.totalBytes = 0;
    this.wireMetas = [];
    this.cachedWireFootprint = null;
    this.lastComputedHash = '';
    this.prefixChainLen = 0;
    this.prefixChainHash = '';
  }

  /**
   * Load from snapshot (for restoration)
   */
  loadFromSnapshot(snapshot: IAppendLogEntry): void {
    if (this.messages.length > 0) {
      throw new AppendOnlyViolationError(
        'Cannot load snapshot into non-empty log'
      );
    }

    if (snapshot.lastMessageIndex !== snapshot.messages.length - 1) {
      throw new AppendOnlyViolationError(
        `Snapshot index mismatch: lastMessageIndex=${snapshot.lastMessageIndex}, ` +
          `messageCount=${snapshot.messages.length}`
      );
    }

    let computedBytes = 0;

    for (const msg of snapshot.messages) {
      const frozen = this.freezeMessage(msg);
      if (!this.validateMessage(frozen)) {
        throw new AppendOnlyViolationError(
          `Snapshot contains invalid message: ${JSON.stringify({
            id: frozen.id,
            role: frozen.role,
            timestamp: frozen.timestamp,
          })}`
        );
      }
      this.messages.push(frozen);
      const serialized = Serializer.stringify(frozen);
      const msgHash = sha256(serialized);
      this.hashes.set(this.messages.length - 1, msgHash);
      const wireMeta = describeLogWireMeta(frozen, serialized);
      this.wireMetas.push(wireMeta);
      computedBytes += wireMeta.bytes;
    }

    if (snapshot.totalBytes !== computedBytes) {
      throw new AppendOnlyViolationError(
        `Snapshot byte count mismatch: expected ${snapshot.totalBytes}, got ${computedBytes}`
      );
    }

    this.totalBytes = computedBytes;
    this.cachedWireFootprint = null;
    this.lastComputedHash = '';
    this.prefixChainLen = 0;
    this.prefixChainHash = '';
  }

  /**
   * Private: Deep freeze a message
   */
  private freezeMessage(msg: IMessage): IMessage {
    return deepFreeze({
      ...msg,
      toolCalls: msg.toolCalls ? Object.freeze([...msg.toolCalls]) : undefined,
      metadata: msg.metadata ? Object.freeze({ ...msg.metadata }) : undefined,
    }) as IMessage;
  }

  /**
   * Private: Validate message structure
   */
  private validateMessage(msg: IMessage): boolean {
    return (
      typeof msg.id === 'string' &&
      msg.id.length > 0 &&
      ['user', 'assistant', 'tool'].includes(msg.role) &&
      typeof msg.content === 'string' &&
      typeof msg.timestamp === 'number' &&
      msg.timestamp > 0
    );
  }
}
