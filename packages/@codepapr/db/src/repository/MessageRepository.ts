/**
 * MessageRepository: 消息仓库 (Append-Only)
 */

import { IMessage, AppendOnlyViolationError } from '@codepapr/types';
import { sha256, Logger } from '@codepapr/common';
import { DSDatabase } from '../Database';

const log = new Logger('MessageRepository');

interface MessageRow {
  id: string;
  role: IMessage['role'];
  content: string;
  message_created_at: number;
  tool_calls: string | null;
  tool_call_id: string | null;
  tool_result: string | null;
  tool_result_success: number | null;
  metadata: string | null;
}

export class MessageRepository {
  constructor(private db: DSDatabase) {}

  /**
   * 追加消息（带 append-only 验证）
   */
  append(sessionId: string, message: IMessage, index: number): void {
    // 验证索引连续性
    const existing = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM messages WHERE session_id = ?`
      )
      .get(sessionId) as { count: number };

    if (existing.count !== index) {
      throw new AppendOnlyViolationError(
        `Message index mismatch: expected ${existing.count}, got ${index}`
      );
    }

    const contentHash = sha256(JSON.stringify(message));

    const metadataPayload = message.reasoningContent
      ? {
          ...message.metadata,
          reasoningContent: message.reasoningContent,
        }
      : message.metadata;

    this.db
      .prepare(
        `INSERT INTO messages (
          id, session_id, message_index, role, content,
          tool_calls, tool_call_id, tool_result, tool_result_success,
          metadata, content_hash, message_created_at, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        message.id,
        sessionId,
        index,
        message.role,
        message.content,
        message.toolCalls ? JSON.stringify(message.toolCalls) : null,
        message.toolResult?.toolCallId ?? null,
        message.toolResult ? JSON.stringify(message.toolResult.result) : null,
        message.toolResult?.success ? 1 : 0,
        metadataPayload ? JSON.stringify(metadataPayload) : null,
        contentHash,
        message.timestamp,
        Date.now()
      );

    log.debug(`Message appended at index ${index}`, { id: message.id });
  }

  /**
   * 获取会话的所有消息（按索引顺序）
   */
  getAll(sessionId: string): IMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE session_id = ? ORDER BY message_index ASC`
      )
      .all(sessionId) as MessageRow[];

    return rows.map((row) => this.rowToMessage(row));
  }

  /**
   * 获取消息数量
   */
  getCount(sessionId: string): number {
    const result = this.db
      .prepare(`SELECT COUNT(*) as count FROM messages WHERE session_id = ?`)
      .get(sessionId) as { count: number };
    return result.count;
  }

  /**
   * 验证消息序列完整性（无缺口）
   */
  validateContinuity(sessionId: string): boolean {
    const rows = this.db
      .prepare(
        `SELECT message_index FROM messages WHERE session_id = ? ORDER BY message_index`
      )
      .all(sessionId) as { message_index: number }[];

    for (let i = 0; i < rows.length; i++) {
      if (rows[i]!.message_index !== i) {
        log.error(`Message index gap at position ${i}`, {
          expected: i,
          actual: rows[i]!.message_index,
        });
        return false;
      }
    }
    return true;
  }

  private rowToMessage(row: MessageRow): IMessage {
    const metadata = row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : undefined;

    return {
      id: row.id,
      role: row.role,
      content: row.content,
      timestamp: row.message_created_at,
      reasoningContent:
        typeof metadata?.reasoningContent === 'string'
          ? metadata.reasoningContent
          : undefined,
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
      toolResult:
        row.tool_result && row.tool_call_id
          ? {
              toolCallId: row.tool_call_id,
              success: !!row.tool_result_success,
              result: JSON.parse(row.tool_result),
            }
          : undefined,
      metadata,
    };
  }
}
