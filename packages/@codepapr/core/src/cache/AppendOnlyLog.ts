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
import { Logger } from '@codepapr/common';

const log = new Logger('AppendOnlyLog');

export class AppendOnlyLog implements IAppendOnlyLog {
  private messages: IMessage[] = [];
  private readonly hashes: Map<number, string> = new Map();
  private totalBytes: number = 0;
  private lastComputedHash: string = '';
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
    const msgHash = sha256(Serializer.stringify(frozen));

    // 4. Store in immutable array
    const index = this.messages.length;
    this.messages.push(frozen);
    this.hashes.set(index, msgHash);

    // 5. Update total bytes
    this.totalBytes += Serializer.getByteLength(frozen);

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
      const msgHash = sha256(Serializer.stringify(frozen));
      this.hashes.set(this.messages.length - 1, msgHash);
      computedBytes += Serializer.getByteLength(frozen);
    }

    if (snapshot.totalBytes !== computedBytes) {
      throw new AppendOnlyViolationError(
        `Snapshot byte count mismatch: expected ${snapshot.totalBytes}, got ${computedBytes}`
      );
    }

    this.totalBytes = computedBytes;
    this.lastComputedHash = '';
  }

  /**
   * Persistence hooks (to be implemented by DB layer)
   */
  async persistToDatabase(): Promise<void> {
    // Implemented by repository layer
  }

  async loadFromDatabase(): Promise<void> {
    // Implemented by repository layer
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
