import { describe, expect, it } from 'vitest';
import { appAgentAllowsMcpTool } from './agentRuntimeLoop';
import { buildMcpToolName } from '../utils/mcpTypes';

describe('appAgentAllowsMcpTool (D-11)', () => {
  const fsServer = buildMcpToolName('filesystem', 'read_file');
  const searchServer = buildMcpToolName('ddg-search', 'search');
  const stdioIds = new Set(['filesystem']);

  it('local:none 禁止 stdio/本地命令类 MCP server（本机进程=本地能力）', () => {
    expect(appAgentAllowsMcpTool(fsServer, 'none', stdioIds)).toBe(false);
  });

  it('local≥read 或远程 transport 不受影响', () => {
    expect(appAgentAllowsMcpTool(fsServer, 'read', stdioIds)).toBe(true);
    expect(appAgentAllowsMcpTool(fsServer, 'write', stdioIds)).toBe(true);
    expect(appAgentAllowsMcpTool(searchServer, 'none', stdioIds)).toBe(true);
  });

  it('非 mcp__ 工具名直接放行（由其它闸门负责）', () => {
    expect(appAgentAllowsMcpTool('websearch', 'none', stdioIds)).toBe(true);
    expect(appAgentAllowsMcpTool('mcp__malformed', 'none', stdioIds)).toBe(true);
  });
});
