import type { WorkspaceProjectGraphResult } from '../../projectGraph';
import { buildNodeMap } from './graphTraversal';

export interface ArchitectureLayer {
  patterns: string[];
  allowedImports: string[];
}

export interface LayerViolation {
  fromPath: string;
  toPath: string;
  fromLayer: string;
  toLayer: string;
  edgeId: string;
}

export interface ArchitectureCheckResult {
  violations: LayerViolation[];
  total: number;
  summary: string;
}

const MAX_LAYER_PATTERN_LENGTH = 200;
// (a+)+ / (a*)* 这类嵌套量词是灾难性回溯（ReDoS）的主要来源。分层 pattern
// 来自用户配置并会对每条边路径执行 test()，直接拒绝常见嵌套量词形态。
const NESTED_QUANTIFIER_PATTERN =
  /\([^()]*(?:[+*]|\{\d+,?\d*\})[^()]*\)(?:[+*?]|\{\d+,?\d*\})/;

function compileLayerPattern(pattern: string): RegExp | null {
  if (!pattern || pattern.length > MAX_LAYER_PATTERN_LENGTH) {
    return null;
  }
  if (NESTED_QUANTIFIER_PATTERN.test(pattern)) {
    return null;
  }
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

export function checkArchitectureLayers(
  graph: WorkspaceProjectGraphResult,
  layers: ArchitectureLayer[],
): ArchitectureCheckResult {
  const violations: LayerViolation[] = [];
  const nodeMap = buildNodeMap(graph);

  const compiledLayers = layers.map((layer) => ({
    ...layer,
    compiledPatterns: layer.patterns
      .map(compileLayerPattern)
      .filter((re): re is RegExp => re !== null),
  }));

  const classifyFile = (path: string): string => {
    for (const layer of compiledLayers) {
      for (const re of layer.compiledPatterns) {
        if (re.test(path)) {
          return layer.patterns[0];
        }
      }
    }
    return '';
  };

  const allowedByLayer = new Map<string, Set<string>>();
  for (const layer of compiledLayers) {
    const allowed = new Set(layer.allowedImports);
    allowedByLayer.set(layer.patterns[0], allowed);
  }

  for (const edge of graph.edges) {
    if (edge.kind !== 'imports' && edge.kind !== 'reexports') continue;

    const fromNode = nodeMap.get(edge.from);
    const toNode = nodeMap.get(edge.to);
    if (!fromNode || !toNode) continue;

    const fromLayer = classifyFile(fromNode.path);
    const toLayer = classifyFile(toNode.path);
    if (!fromLayer || !toLayer || fromLayer === toLayer) continue;

    const allowed = allowedByLayer.get(fromLayer);
    if (allowed && !allowed.has(toLayer)) {
      violations.push({
        fromPath: fromNode.path,
        toPath: toNode.path,
        fromLayer,
        toLayer,
        edgeId: edge.id,
      });
    }
  }

  return {
    violations,
    total: violations.length,
    summary: violations.length === 0
      ? '未检测到架构分层违规。'
      : `检测到 ${violations.length} 个分层违规。`,
  };
}
