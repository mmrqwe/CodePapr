/**
 * ProjectGraph 节点 ID：
 * - 文件：`file:${path}`
 * - 符号（生产）：`symbol:${path}:${line}:${kind}:${containerName}:${name}:${index}`
 * - 符号（测试简写）：`symbol:${path}:${name}`
 *
 * Windows 盘符路径含冒号（`C:/repo/a.ts`），不能在 `symbol:` 之后取第一个冒号当路径结束。
 */

const PRODUCTION_SYMBOL_ID = /^(.*):(\d+):([^:]*):([^:]*):(.*):(\d+)$/;

export function fileIdFromGraphNodeId(nodeId: string): string | null {
  if (nodeId.startsWith('file:')) {
    return nodeId;
  }
  if (!nodeId.startsWith('symbol:')) {
    return null;
  }

  const rest = nodeId.slice('symbol:'.length);
  if (!rest) {
    return null;
  }

  const production = rest.match(PRODUCTION_SYMBOL_ID);
  const path = production ? production[1] : rest.slice(0, Math.max(0, rest.lastIndexOf(':'))) || rest;
  return path ? `file:${path}` : null;
}
