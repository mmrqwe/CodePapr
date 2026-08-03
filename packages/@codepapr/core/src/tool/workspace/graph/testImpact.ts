import type { ProjectGraphNode, WorkspaceProjectGraphResult } from '../../projectGraph';
import { buildEdgeMaps } from './graphTraversal';
import { discoverAndMapTests } from './testDiscovery';

export interface ImpactBasedTestSelectionResult {
  changedFiles: string[];
  affectedTests: string[];
  selectedTests: Array<{ path: string; name: string; line: number }>;
  reasoning: string[];
  summary: string;
}

export function selectTestsByChangeImpact(
  graph: WorkspaceProjectGraphResult,
  changedFiles: string[],
): ImpactBasedTestSelectionResult {
  const testDiscovery = discoverAndMapTests(graph);
  const reasoning: string[] = [];

  const impactedFiles = new Set<string>(changedFiles);
  for (const changedFile of changedFiles) {
    const impact = analyzeChangeImpactInternal(graph, changedFile);
    for (const node of impact) {
      impactedFiles.add(node.path);
    }
    reasoning.push(`${changedFile} 变更影响 ${impact.length} 个下游文件`);
  }

  const selectedTests: Array<{ path: string; name: string; line: number }> = [];
  const affectedTests = new Set<string>();

  for (const impactedFile of impactedFiles) {
    for (const [testFile, sources] of testDiscovery.mappedSources) {
      if (sources.includes(impactedFile)) {
        affectedTests.add(testFile);
        break;
      }
    }
  }

  for (const tf of testDiscovery.testFunctions) {
    if (affectedTests.has(tf.path)) {
      selectedTests.push(tf);
    } else {
      for (const impactedFile of impactedFiles) {
        if (tf.path.includes(impactedFile.replace(/\.[^.]+$/, '')) ||
            impactedFile.includes(tf.name.replace(/^(test|spec|Test|it\s*\(['"])\s*/, ''))) {
          selectedTests.push(tf);
          affectedTests.add(tf.path);
          break;
        }
      }
    }
  }

  return {
    changedFiles,
    affectedTests: [...affectedTests],
    selectedTests,
    reasoning,
    summary: `${changedFiles.length} 个变更文件 → ${impactedFiles.size} 个影响范围 → ${affectedTests.size} 个需运行的测试文件。`,
  };
}

function analyzeChangeImpactInternal(
  graph: WorkspaceProjectGraphResult,
  filePath: string,
): ProjectGraphNode[] {
  const edgeMap = buildEdgeMaps(graph);
  const fileNode = graph.nodes.find(
    (n) => n.kind === 'file' && n.path === filePath,
  );
  if (!fileNode) return [];

  const DEPENDENCY_KINDS = new Set(['imports', 'reexports', 'calls', 'extends', 'implements']);
  const MAX_DEPTH = 6;
  const impacted = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: fileNode.id, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= MAX_DEPTH) continue;
    const inEdges = edgeMap.incoming.get(current.id) ?? [];
    for (const edge of inEdges) {
      if (!DEPENDENCY_KINDS.has(edge.kind)) continue;
      if (!impacted.has(edge.from)) {
        impacted.add(edge.from);
        queue.push({ id: edge.from, depth: current.depth + 1 });
      }
    }
  }

  return graph.nodes.filter(
    (n) => impacted.has(n.id) && n.kind !== 'file',
  );
}
