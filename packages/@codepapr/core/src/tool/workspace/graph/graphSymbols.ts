import type { ProjectGraphNode, WorkspaceProjectGraphResult } from '../../projectGraph';

export interface WorkspaceGraphSymbolMatch {
  symbolId: string;
  name: string;
  qualifiedName?: string;
  kind: string;
  path: string;
  language?: string;
  line?: number;
  containerName?: string;
  signature?: string;
  exported?: boolean;
  async?: boolean;
  symbolSource?: string;
  entryPoint?: boolean;
  entryPointScore?: number;
}

export function normalizeText(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export function graphSymbolNodes(graph: WorkspaceProjectGraphResult): ProjectGraphNode[] {
  return graph.nodes.filter((node) => node.kind === 'symbol' && node.symbol);
}

export function toGraphSymbolMatch(node: ProjectGraphNode): WorkspaceGraphSymbolMatch {
  return {
    symbolId: node.id,
    name: node.label,
    qualifiedName: node.qualifiedName,
    kind: node.symbol?.kind ?? 'symbol',
    path: node.path,
    language: node.language,
    line: node.symbol?.line,
    containerName: node.symbol?.containerName,
    signature: node.symbol?.signature,
    exported: node.symbol?.exported,
    async: node.symbol?.async,
    symbolSource: node.symbolSource,
    entryPoint: node.entryPoint,
    entryPointScore: node.entryPointScore,
  };
}

export function isTypeSymbolKind(kind: string): boolean {
  return /^(class|interface|struct|enum|trait|type|protocol|object|actor|record|module)$/i.test(kind);
}

export function isCallableSymbolKind(kind: string): boolean {
  return /^(function|method|constructor|arrow|local_function|fn|def|func|sub)$/i.test(kind);
}

export function isTestFile(path: string): boolean {
  return /[._](test|spec|_test)\.\w+$|^test[._]/i.test(path);
}
