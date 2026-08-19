import type { WorkspaceProjectGraphResult } from '../../projectGraph';

export type DeadCodeConfidence = 'likely' | 'candidate';

export interface DeadCodeSymbol {
  id: string;
  name: string;
  kind: string;
  path: string;
  line: number;
  exported?: boolean;
  confidence: DeadCodeConfidence;
  reason: string;
}

export interface DeadCodeResult {
  unusedSymbols: DeadCodeSymbol[];
  exportedCandidates: DeadCodeSymbol[];
  total: number;
  candidateTotal: number;
  summary: string;
}

const FRAMEWORK_CALLBACK_NAMES = new Set([
  'render',
  'setup',
  'created',
  'mounted',
  'unmounted',
  'updated',
  'destroyed',
  'ngoninit',
  'ngondestroy',
  'ngonchanges',
  'componentdidmount',
  'componentwillunmount',
  'componentdidupdate',
  'shouldcomponentupdate',
  '_ready',
  '_entertree',
  '_process',
  '_physicsprocess',
]);

const TEST_PATH_RE = /(?:^|\/)(?:__tests__|__mocks__|tests?|spec)(?:\/|$)/i;
const TEST_FILE_RE = /\.(?:test|spec|tests)\b/i;

function isTestPath(path: string): boolean {
  return TEST_PATH_RE.test(path) || TEST_FILE_RE.test(path);
}

function isFrameworkCallback(name: string, kind: string, exported: boolean | undefined): boolean {
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  if (FRAMEWORK_CALLBACK_NAMES.has(lower)) {
    return true;
  }
  if (/^(on[A-Z]|handle[A-Z]|use[A-Z])/.test(trimmed)) {
    return true;
  }
  if (exported && /^[A-Z]/.test(trimmed) && (kind === 'function' || kind === 'class' || kind === 'method')) {
    return true;
  }
  return false;
}

function classifyUnusedSymbol(params: {
  name: string;
  kind: string;
  path: string;
  exported?: boolean;
}): { confidence: DeadCodeConfidence; reason: string } {
  if (isTestPath(params.path)) {
    return { confidence: 'candidate', reason: 'test-file' };
  }
  if (params.exported) {
    return { confidence: 'candidate', reason: 'exported-public-api' };
  }
  if (isFrameworkCallback(params.name, params.kind, params.exported)) {
    return { confidence: 'candidate', reason: 'framework-callback' };
  }
  return { confidence: 'likely', reason: 'no-inbound-reference' };
}

export function detectDeadCode(
  graph: WorkspaceProjectGraphResult,
): DeadCodeResult {
  const inbound = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.kind === 'symbol') {
      inbound.set(node.id, 0);
    }
  }

  for (const edge of graph.edges) {
    // 注意：'contains' 是文件/容器到符号的结构性归属边，每个符号必然有且仅有一条，
    // 不代表真实引用/调用，绝不能计入"被使用"的证据，否则死代码检测永远不会命中。
    if (edge.kind === 'imports' || edge.kind === 'calls' ||
        edge.kind === 'extends' || edge.kind === 'implements' ||
        edge.kind === 'reexports' || edge.kind === 'tested_by') {
      const current = inbound.get(edge.to) ?? 0;
      inbound.set(edge.to, current + 1);
    }
  }

  const unusedSymbols: DeadCodeSymbol[] = [];
  const exportedCandidates: DeadCodeSymbol[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== 'symbol' || !node.symbol) continue;
    if (node.entryPoint) continue;
    if (node.symbol.name === 'main' || node.symbol.name === 'init') continue;

    const count = inbound.get(node.id) ?? 0;
    if (count <= 0) {
      const classification = classifyUnusedSymbol({
        name: node.symbol.name,
        kind: node.symbol.kind,
        path: node.path,
        exported: node.symbol.exported,
      });
      const item: DeadCodeSymbol = {
        id: node.id,
        name: node.symbol.name,
        kind: node.symbol.kind,
        path: node.path,
        line: node.symbol.line,
        exported: node.symbol.exported,
        confidence: classification.confidence,
        reason: classification.reason,
      };
      if (classification.confidence === 'likely') {
        unusedSymbols.push(item);
      } else {
        exportedCandidates.push(item);
      }
    }
  }

  return {
    unusedSymbols,
    exportedCandidates,
    total: unusedSymbols.length,
    candidateTotal: exportedCandidates.length,
    summary: unusedSymbols.length === 0 && exportedCandidates.length === 0
      ? '未检测到死代码。'
      : `启发式检测到 ${unusedSymbols.length} 个内部无引用符号` +
        (exportedCandidates.length > 0
          ? `，另有 ${exportedCandidates.length} 个导出/框架回调候选（可能是公共 API 或反射入口，不作为强结论）。`
          : '。'),
  };
}
