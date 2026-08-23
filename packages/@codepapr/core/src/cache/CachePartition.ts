/**
 * CachePartition: Container for the three-partition model
 *
 * Unifies:
 * - ImmutablePrefix: Frozen system prompt, tools, few-shots
 * - AppendOnlyLog: Message history (user, assistant, tool results)
 * - VolatileScratch: Model thinking (never serialized)
 */

import {
  ICachePartition,
  IImmutablePrefix,
  IAppendOnlyLog,
  IVolatileScratch,
  IMessage,
  IModelParameters,
  IToolDefinition,
  CacheConsistencyError,
} from '@codepapr/types';
import { ImmutablePrefix } from './ImmutablePrefix';
import { AppendOnlyLog } from './AppendOnlyLog';
import { VolatileScratch } from './VolatileScratch';

export class CachePartition implements ICachePartition {
  constructor(
    readonly prefix: IImmutablePrefix,
    readonly log: IAppendOnlyLog,
    readonly scratch: IVolatileScratch
  ) {}

  /**
   * Get prefix hash
   */
  getPrefixHash(): string {
    return this.prefix.computeHash();
  }

  /**
   * Get log hash
   */
  getLogHash(): string {
    return this.log.computeHash();
  }

  /**
   * Get log total bytes
   */
  getLogBytes(): number {
    return this.log.getContentBytes();
  }

  /**
   * Get message count in log
   */
  getLogMessageCount(): number {
    return this.log.length();
  }

  /**
   * Validate all three partitions
   */
  validate(): boolean {
    // Validate prefix (should never fail once created)
    if (!this.prefix.validate()) {
      throw new CacheConsistencyError('Prefix validation failed - hash mismatch!');
    }

    // Validate log (check append-only invariants)
    if (!this.log.validate()) {
      throw new CacheConsistencyError('Log validation failed - append-only invariant violated!');
    }

    // Scratch validation (should always pass)
    if (this.scratch.toJSON() !== null) {
      throw new CacheConsistencyError('Scratch serialized - this should never happen!');
    }

    return true;
  }

  /**
   * Serialize to message array (prefix + log only)
   * NEVER includes scratch
   */
  toMessageArray(): IMessage[] {
    const messages: IMessage[] = [];

    // Add prefix messages (system prompt)
    messages.push(...this.prefix.toMessageArray());

    // Add log messages (conversation history)
    messages.push(...this.log.toMessageArray());

    return messages;
  }

  /**
   * Create a cache partition from configuration
   */
  static create(config: {
    systemPrompt: string;
    tools: IToolDefinition[];
    fewShots?: IMessage[];
    model: string;
    parameters: IModelParameters;
    sessionId: string;
  }): CachePartition {
    const prefix = new ImmutablePrefix({
      systemPrompt: config.systemPrompt,
      tools: config.tools,
      fewShots: config.fewShots,
      model: config.model,
      parameters: config.parameters,
    });

    const log = new AppendOnlyLog(config.sessionId);
    const scratch = new VolatileScratch();

    return new CachePartition(prefix, log, scratch);
  }
}
