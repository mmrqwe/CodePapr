/**
 * ToolRepository: 工具定义仓库
 */

import { IToolDefinition } from '@codepapr/types';
import { sha256, generateUUID, Logger } from '@codepapr/common';
import { DSDatabase } from '../Database';

const log = new Logger('ToolRepository');

interface ToolRow {
  name: string;
  description: string;
  parameters_schema: string;
}

export class ToolRepository {
  constructor(private db: DSDatabase) {}

  save(sessionId: string, tool: IToolDefinition): void {
    const hash = sha256(JSON.stringify(tool));

    this.db
      .prepare(
        `INSERT OR REPLACE INTO tools (
          id, session_id, name, description, parameters_schema,
          definition_hash, frozen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        generateUUID(),
        sessionId,
        tool.name,
        tool.description,
        JSON.stringify(tool.parameters),
        hash,
        Date.now()
      );

    log.debug(`Tool saved: ${tool.name}`);
  }

  getAll(sessionId: string): IToolDefinition[] {
    const rows = this.db
      .prepare(`SELECT * FROM tools WHERE session_id = ?`)
      .all(sessionId) as ToolRow[];

    return rows.map((row) => ({
      name: row.name,
      description: row.description,
      parameters: JSON.parse(row.parameters_schema),
    }));
  }
}
