import {
  detectDeadCode,
  detectCircularDependencies,
  findWorkspaceEntrypoints,
  fileIdFromGraphNodeId,
  type CircularDependencyResult,
  type DeadCodeResult,
  type ProjectGraphNode,
  type WorkspaceEntrypointsResult,
  type WorkspaceProjectGraphResult,
} from '@codepapr/core';

export interface HubFile {
  nodeId: string;
  path: string;
  inDegree: number;
  outDegree: number;
}

export interface ProjectGraphInsights {
  deadCode: DeadCodeResult;
  circularDeps: CircularDependencyResult;
  hubs: HubFile[];
  orphans: ProjectGraphNode[];
  testGaps: ProjectGraphNode[];
  entryPoints: WorkspaceEntrypointsResult;
}

const HUB_LIMIT = 10;
const ORPHAN_LIMIT = 30;
const TEST_GAP_LIMIT = 30;

// 与 core/deadCode 保持一致的"真实引用"边类型：contains 是结构归属边，
// tested_by/configures 是辅助语义边，均不代表代码级依赖，不计入文件度数。
const DEGREE_EDGE_KINDS = new Set(['imports', 'reexports', 'extends', 'implements', 'calls']);

/**
 * 从已构建的 ProjectGraph 同步计算可操作的项目洞察：
 * 死代码、循环依赖、核心枢纽（被依赖最多）、孤儿文件、测试覆盖缺口、入口点。
 * 全部复用 @codepapr/core 的既有分析函数，纯计算、无 IO。
 */
export function computeProjectGraphInsights(
  graph: WorkspaceProjectGraphResult,
): ProjectGraphInsights {
  const deadCode = detectDeadCode(graph);
  const circularDeps = detectCircularDependencies(graph);
  const entryPoints = findWorkspaceEntrypoints(graph, 20);

  const fileNodes = graph.nodes.filter((node) => node.kind === 'file');
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  const totalDegree = new Map<string, number>();
  for (const node of fileNodes) {
    inDegree.set(node.id, 0);
    outDegree.set(node.id, 0);
    totalDegree.set(node.id, 0);
  }

  // 符号级边归并到所属文件，得到文件级度数。
  for (const edge of graph.edges) {
    if (!DEGREE_EDGE_KINDS.has(edge.kind)) continue;
    const from = fileIdFromGraphNodeId(edge.from);
    const to = fileIdFromGraphNodeId(edge.to);
    if (!from || !to || from === to) continue;
    outDegree.set(from, (outDegree.get(from) ?? 0) + 1);
    inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
    totalDegree.set(from, (totalDegree.get(from) ?? 0) + 1);
    totalDegree.set(to, (totalDegree.get(to) ?? 0) + 1);
  }

  const hubs = fileNodes
    .map((node) => ({
      nodeId: node.id,
      path: node.path,
      inDegree: inDegree.get(node.id) ?? 0,
      outDegree: outDegree.get(node.id) ?? 0,
    }))
    .filter((hub) => hub.inDegree > 0)
    .sort((a, b) => b.inDegree - a.inDegree || a.path.localeCompare(b.path))
    .slice(0, HUB_LIMIT);

  // 孤儿文件：无任何依赖关系且不是入口的源码文件（文档/配置天然独立，不报）。
  const orphans = fileNodes
    .filter(
      (node) =>
        !node.entryPoint &&
        (node.fileType === 'source' || node.fileType === undefined) &&
        (totalDegree.get(node.id) ?? 0) === 0,
    )
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, ORPHAN_LIMIT);

  // 测试覆盖缺口：项目存在测试文件时，没有被 tested_by 覆盖的源码文件。
  const testedTargets = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind === 'tested_by') testedTargets.add(edge.to);
  }
  const testGaps =
    (graph.summary.testFiles ?? 0) > 0
      ? fileNodes
          .filter(
            (node) =>
              (node.fileType === 'source' || node.fileType === undefined) &&
              !testedTargets.has(node.id),
          )
          .sort((a, b) => a.path.localeCompare(b.path))
          .slice(0, TEST_GAP_LIMIT)
      : [];

  return { deadCode, circularDeps, hubs, orphans, testGaps, entryPoints };
}
