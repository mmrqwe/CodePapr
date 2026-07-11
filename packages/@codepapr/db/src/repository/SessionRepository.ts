/**
 * SessionRepository: 会话仓库
 */

import {
  ISessionConfig,
  IToolDefinition,
  ICacheStatistics,
} from '@codepapr/types';
import { generateUUID, Logger } from '@codepapr/common';
import { DSDatabase } from '../Database';

const log = new Logger('SessionRepository');

interface SessionRow {
  id: string;
  created_at: number;
  last_modified: number;
  model: string;
  provider: ISessionConfig['provider'];
  system_prompt: string;
  parameters: string | null;
  prefix_frozen_at: number | null;
  prefix_hash: string | null;
}

export class SessionRepository {
  constructor(private db: DSDatabase) {}

  create(config: Omit<ISessionConfig, 'sessionId' | 'createdAt' | 'lastModified'>): string {
    const id = generateUUID();
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO sessions (
        id, name, model, provider, system_prompt,
        prefix_hash, prefix_bytes, prefix_frozen_at,
        parameters, created_at, last_modified, is_archived
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);

    stmt.run(
      id,
      `session-${id.slice(0, 8)}`,
      config.model,
      config.provider,
      config.systemPrompt,
      config.prefixHash ?? null,
      null,
      config.isPrefixFrozen ? now : null,
      JSON.stringify(config.parameters ?? {}),
      now,
      now
    );

    log.info(`Session created: ${id}`);
    return id;
  }

  get(sessionId: string): ISessionConfig | null {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(sessionId) as SessionRow | undefined;

    if (!row) return null;

    return {
      sessionId: row.id,
      createdAt: row.created_at,
      lastModified: row.last_modified,
      model: row.model,
      provider: row.provider,
      tools: [],
      systemPrompt: row.system_prompt,
      parameters: JSON.parse(row.parameters || '{}'),
      isPrefixFrozen: !!row.prefix_frozen_at,
      prefixHash: row.prefix_hash ?? undefined,
    };
  }

  update(sessionId: string, updates: Partial<ISessionConfig>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.prefixHash !== undefined) {
      fields.push('prefix_hash = ?');
      values.push(updates.prefixHash);
    }
    if (updates.isPrefixFrozen !== undefined) {
      fields.push('prefix_frozen_at = ?');
      values.push(updates.isPrefixFrozen ? Date.now() : null);
    }
    if (updates.systemPrompt !== undefined) {
      fields.push('system_prompt = ?');
      values.push(updates.systemPrompt);
    }

    fields.push('last_modified = ?');
    values.push(Date.now());
    values.push(sessionId);

    this.db
      .prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`)
      .run(...values);
  }

  delete(sessionId: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
    log.info(`Session deleted: ${sessionId}`);
  }

  list(): ISessionConfig[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions ORDER BY last_modified DESC`)
      .all() as SessionRow[];

    return rows.map((row) => ({
      sessionId: row.id,
      createdAt: row.created_at,
      lastModified: row.last_modified,
      model: row.model,
      provider: row.provider,
      tools: [] as IToolDefinition[],
      systemPrompt: row.system_prompt,
      parameters: JSON.parse(row.parameters || '{}'),
      isPrefixFrozen: !!row.prefix_frozen_at,
      prefixHash: row.prefix_hash ?? undefined,
    }));
  }

  updateStats(sessionId: string, stats: ICacheStatistics): void {
    this.db
      .prepare(
        `UPDATE sessions SET
         total_cache_creation_tokens = total_cache_creation_tokens + ?,
         total_cache_read_tokens = total_cache_read_tokens + ?,
         total_input_tokens = total_input_tokens + ?,
         total_output_tokens = total_output_tokens + ?,
         last_modified = ?
         WHERE id = ?`
      )
      .run(
        stats.cacheCreationTokens,
        stats.cacheReadTokens,
        stats.newInputTokens,
        stats.outputTokens,
        Date.now(),
        sessionId
      );
  }
}
