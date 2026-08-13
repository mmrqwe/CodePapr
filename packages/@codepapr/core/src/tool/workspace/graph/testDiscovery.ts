import type { WorkspaceProjectGraphResult } from '../../projectGraph';
import { isTestFile } from './graphSymbols';
import { buildEdgeMaps, buildNodeMap } from './graphTraversal';

export interface TestDiscoveryResult {
  testFiles: string[];
  testFunctions: Array<{ path: string; name: string; line: number }>;
  mappedSources: Map<string, string[]>;
  summary: string;
}

export function discoverAndMapTests(
  graph: WorkspaceProjectGraphResult,
): TestDiscoveryResult {
  const nodeMap = buildNodeMap(graph);
  const edgeMap = buildEdgeMaps(graph);
  const testFiles: string[] = [];
  const testFunctions: Array<{ path: string; name: string; line: number }> = [];

  const TEST_FILE_PATTERNS = /[._](test|spec|_test)\.\w+$|^test[._]|\.test\./i;
  // 符号名来自 AST/LSP 提取，是纯标识符（不含括号）：旧模式的 ^it\( / ^describe\(
  // 恒不匹配，vitest/jest 的 it/test/describe 与裸 test 函数全部漏检。
  // 改为按标识符精确匹配框架入口名 + 前缀约定（testFoo/test_foo、TestFoo、Spec_）。
  const TEST_FUNC_PATTERNS = /^(it|test|describe|suite)$|^test[A-Z_]|^Spec_|^Test[A-Z_]/;

  for (const node of nodeMap.values()) {
    if (node.kind !== 'symbol' || !node.symbol) continue;

    if (TEST_FILE_PATTERNS.test(node.path)) {
      if (!testFiles.includes(node.path)) {
        testFiles.push(node.path);
      }
      if (TEST_FUNC_PATTERNS.test(node.symbol.name)) {
        testFunctions.push({
          path: node.path,
          name: node.symbol.name,
          line: node.symbol.line,
        });
      }
    }
  }

  const mappedSources = new Map<string, string[]>();
  for (const testFile of testFiles) {
    const sources: string[] = [];
    const outEdges = edgeMap.outgoing.get(`file:${testFile}`) ?? [];
    for (const edge of outEdges) {
      if (edge.kind !== 'imports' && edge.kind !== 'calls') continue;
      const toNode = nodeMap.get(edge.to);
      if (!toNode || isTestFile(toNode.path)) continue;
      if (!sources.includes(toNode.path)) {
        sources.push(toNode.path);
      }
    }

    if (sources.length === 0) {
      for (const edge of outEdges) {
        if (edge.kind !== 'imports') continue;
        const toNode = nodeMap.get(edge.to);
        if (toNode && !isTestFile(toNode.path) && !sources.includes(toNode.path)) {
          sources.push(toNode.path);
        }
      }
    }

    if (sources.length > 0) {
      mappedSources.set(testFile, sources);
    }
  }

  return {
    testFiles,
    testFunctions,
    mappedSources,
    summary: `${testFiles.length} 个测试文件，${testFunctions.length} 个测试函数，${mappedSources.size} 个被测源文件映射。`,
  };
}
