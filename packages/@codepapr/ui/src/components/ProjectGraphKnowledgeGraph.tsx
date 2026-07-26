import { forwardRef, useEffect, useImperativeHandle, useRef, useCallback, useState, useMemo } from 'react';
import { Graph } from '@antv/g6';
import type { GraphOptions, NodeData, EdgeData } from '@antv/g6';
import { Renderer as WebGLRenderer } from '@antv/g-webgl';
import type {
  ProjectGraphNode,
  ProjectGraphEdge,
  WorkspaceProjectGraphResult,
} from '@codepapr/core';
import { getTranslation } from '../utils/i18n';

const EDGE_COLORS: Record<string, string> = {
  imports: '#58a6ff',
  reexports: '#d29922',
  extends: '#3fb950',
  implements: '#8b949e',
  calls: '#f78166',
  contains: '#6e7681',
  tested_by: '#2dd4bf',
  configures: '#c084fc',
};

const SYMBOL_COLORS: Record<string, string> = {
  class: '#3fb950',
  interface: '#a371f7',
  function: '#58a6ff',
  method: '#58a6ff',
  type: '#d29922',
  typedef: '#d29922',
  constructor: '#f0883e',
  arrow: '#58a6ff',
};

const FILE_TYPE_COLORS: Record<string, string> = {
  test: '#f59e0b',
  config: '#c084fc',
  doc: '#2dd4bf',
  docker: '#06b6d4',
  cicd: '#e879f9',
  sql: '#f472b6',
  source: '#6366f1',
};

const FOLDER_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316',
  '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82b6',
  '#a855f7', '#db2777', '#ea580c', '#ca8a04', '#16a34a',
];

function parentFolder(filePath: string): string {
  const segments = filePath.replace(/\\/g, '/').split('/');
  if (segments.length <= 1) return '.';
  return segments.slice(0, -1).join('/');
}

function folderColor(folder: string): string {
  let hash = 0;
  for (let i = 0; i < folder.length; i++) {
    hash = ((hash << 5) - hash) + folder.charCodeAt(i);
    hash |= 0;
  }
  return FOLDER_COLORS[Math.abs(hash) % FOLDER_COLORS.length];
}

function symbolNodeColor(kind: string): string {
  return SYMBOL_COLORS[kind] ?? '#8b949e';
}

function scaleSize(
  degree: number,
  minDegree: number,
  maxDegree: number,
  minSize: number,
  maxSize: number,
): number {
  if (maxDegree <= minDegree) return Math.round((minSize + maxSize) / 2);
  const t = Math.log(1 + degree - minDegree) / Math.log(1 + maxDegree - minDegree);
  return Math.round(minSize + (maxSize - minSize) * t);
}

function shortenLabel(label: string, maxLen: number = 20): string {
  if (label.length <= maxLen) return label;
  return label.slice(0, maxLen - 3) + '...';
}

function fileNameFromPath(filePath: string): string {
  const segments = filePath.replace(/\\/g, '/').split('/');
  const lastTwo = segments.length > 1 ? segments.slice(-2).join('/') : segments[0];
  return shortenLabel(lastTwo, 30);
}

function symbolDisplayLabel(node: ProjectGraphNode): string {
  const markers: string[] = [];
  if (node.symbol?.async) markers.push('\u25B8');
  if (node.symbol?.exported) markers.push('\u2605');
  const name = shortenLabel(node.label, 22);
  return markers.length > 0 ? markers.join('') + name : name;
}

interface NodeDegrees {
  in: number;
  out: number;
  total: number;
}

function computeDegrees(
  nodes: ProjectGraphNode[],
  edges: ProjectGraphEdge[],
): Map<string, NodeDegrees> {
  const map = new Map<string, NodeDegrees>();
  for (const node of nodes) {
    map.set(node.id, { in: 0, out: 0, total: 0 });
  }
  for (const edge of edges) {
    if (edge.kind === 'contains') continue;
    if (edge.kind === 'tested_by' || edge.kind === 'configures') continue;
    const fromDeg = map.get(edge.from);
    const toDeg = map.get(edge.to);
    if (fromDeg) { fromDeg.out++; fromDeg.total++; }
    if (toDeg) { toDeg.in++; toDeg.total++; }
  }
  return map;
}

interface G6NodeData {
  label: string;
  fullLabel: string;
  nodeKind: 'file' | 'symbol';
  fullPath: string;
  language?: string;
  isEntry: boolean;
  fileType?: string;
  symbolKind?: string;
  line?: number;
  signature?: string;
  exported?: boolean;
  async?: boolean;
  inDegree: number;
  outDegree: number;
  parentFolder?: string;
  [key: string]: unknown;
}

interface G6Data {
  nodes: Array<{
    id: string;
    data: G6NodeData;
    style: {
      fill: string;
      stroke: string;
      size: number;
      x?: number;
      y?: number;
    };
  }>;
  edges: Array<{
    source: string;
    target: string;
    data: {
      label: string;
      kind: string;
    };
    style: {
      stroke: string;
      lineWidth: number;
      endArrow: boolean;
    };
  }>;
}

function buildG6Data(
  nodes: ProjectGraphNode[],
  edges: ProjectGraphEdge[],
  viewModes?: Set<string>,
): G6Data {
  const modes = viewModes ?? new Set(['deps']);
  const showDeps = modes.has('deps');
  const showHierarchy = modes.has('hierarchy');
  const showCalls = modes.has('calls');

  const nodeById = new Map<string, ProjectGraphNode>();
  const fileNodes: ProjectGraphNode[] = [];
  for (const node of nodes) {
    nodeById.set(node.id, node);
    if (node.kind === 'file') fileNodes.push(node);
  }

  const degrees = computeDegrees(nodes, edges);

  const maxFileDeg = Math.max(1, ...fileNodes.map((n) => degrees.get(n.id)?.total ?? 0));
  const minFileDeg = Math.min(0, ...fileNodes.map((n) => degrees.get(n.id)?.total ?? 0));

  const rankedFiles = [...fileNodes].sort((a, b) => {
    const degDiff = (degrees.get(b.id)?.total ?? 0) - (degrees.get(a.id)?.total ?? 0);
    if (degDiff !== 0) return degDiff;
    const scoreDiff = (b.entryPointScore ?? 0) - (a.entryPointScore ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    return (b.bytes ?? 0) - (a.bytes ?? 0);
  });

  const includedNodeIds = new Set<string>();
  const g6Nodes: G6Data['nodes'] = [];
  const g6Edges: G6Data['edges'] = [];
  const seenEdgeKeys = new Set<string>();

  const pushEdge = (edge: { source: string; target: string; data: { label: string; kind: string }; style: { stroke: string; lineWidth: number; endArrow: boolean } }) => {
    const key = `${edge.source}->${edge.target}::${edge.data.kind}`;
    if (seenEdgeKeys.has(key)) return;
    seenEdgeKeys.add(key);
    g6Edges.push(edge);
  };

  for (const fileNode of rankedFiles) {
    includedNodeIds.add(fileNode.id);
    const deg = degrees.get(fileNode.id)?.total ?? 0;
    const isEntry = Boolean(fileNode.entryPoint);
    const folder = parentFolder(fileNode.path);
    const ft = fileNode.fileType;

    g6Nodes.push({
      id: fileNode.id,
      data: {
        label: fileNameFromPath(fileNode.path),
        fullLabel: fileNode.path.replace(/\\/g, '/').split('/').pop() ?? fileNode.path,
        nodeKind: 'file',
        fullPath: fileNode.path,
        language: fileNode.language,
        isEntry,
        fileType: ft,
        inDegree: degrees.get(fileNode.id)?.in ?? 0,
        outDegree: degrees.get(fileNode.id)?.out ?? 0,
        parentFolder: folder,
      },
      style: {
        fill: ft && ft !== 'source' ? (FILE_TYPE_COLORS[ft] ?? folderColor(folder)) : folderColor(folder),
        stroke: isEntry ? '#f0883e' : '#30363d',
        size: scaleSize(deg, minFileDeg, maxFileDeg, 30, 70),
      },
    });
  }

  const HIERARCHY_SYMBOL_KINDS = new Set(['class', 'interface', 'struct', 'enum', 'record']);

  if (showHierarchy) {
    const hierarchyEdgeEndpoints = new Set<string>();
    for (const edge of edges) {
      if (edge.kind === 'extends' || edge.kind === 'implements') {
        hierarchyEdgeEndpoints.add(edge.from);
        hierarchyEdgeEndpoints.add(edge.to);
      }
    }

    const hierarchySymbols = nodes.filter(
      (n) => n.kind === 'symbol' && n.symbol && HIERARCHY_SYMBOL_KINDS.has(n.symbol.kind) && hierarchyEdgeEndpoints.has(n.id),
    );

    const maxHSymDeg = Math.max(1, ...hierarchySymbols.map((n) => degrees.get(n.id)?.total ?? 0));
    const minHSymDeg = Math.min(0, ...hierarchySymbols.map((n) => degrees.get(n.id)?.total ?? 0));

    const rankedHierarchySymbols = [...hierarchySymbols].sort(
      (a, b) => (degrees.get(b.id)?.total ?? 0) - (degrees.get(a.id)?.total ?? 0),
    );

    for (const symNode of rankedHierarchySymbols) {
      includedNodeIds.add(symNode.id);
      const deg = degrees.get(symNode.id)?.total ?? 0;
      g6Nodes.push({
        id: symNode.id,
        data: {
          label: symbolDisplayLabel(symNode),
          fullLabel: symNode.label,
          nodeKind: 'symbol',
          fullPath: symNode.path,
          symbolKind: symNode.symbol?.kind,
          line: symNode.symbol?.line,
          signature: symNode.symbol?.signature,
          exported: symNode.symbol?.exported,
          async: symNode.symbol?.async,
          isEntry: false,
          inDegree: degrees.get(symNode.id)?.in ?? 0,
          outDegree: degrees.get(symNode.id)?.out ?? 0,
        },
        style: {
          fill: symbolNodeColor(symNode.symbol?.kind ?? ''),
          stroke: symNode.symbol?.exported ? '#f0883e' : '#30363d',
          size: scaleSize(deg, minHSymDeg, maxHSymDeg, 20, 45),
        },
      });
    }
  }

  if (showCalls) {
    const crossFileCalls = edges.filter((e) => {
      if (e.kind !== 'calls') return false;
      const fromNode = nodeById.get(e.from);
      const toNode = nodeById.get(e.to);
      return fromNode && toNode && fromNode.path !== toNode.path;
    });

    crossFileCalls.sort((a, b) => {
      const inDegA = degrees.get(a.to)?.in ?? 0;
      const inDegB = degrees.get(b.to)?.in ?? 0;
      return inDegB - inDegA;
    });

    const topCalls = crossFileCalls.slice(0, 200);

    const callSymbolIds = new Set<string>();
    for (const edge of topCalls) {
      const fromNode = nodeById.get(edge.from);
      const toNode = nodeById.get(edge.to);
      if (fromNode?.kind === 'symbol') callSymbolIds.add(edge.from);
      if (toNode?.kind === 'symbol') callSymbolIds.add(edge.to);
    }

    const callSymbols = [...callSymbolIds].map((id) => nodeById.get(id)).filter(Boolean) as ProjectGraphNode[];
    const maxCSymDeg = Math.max(1, ...callSymbols.map((n) => degrees.get(n.id)?.total ?? 0));
    const minCSymDeg = Math.min(0, ...callSymbols.map((n) => degrees.get(n.id)?.total ?? 0));

    const rankedCallSymbols = callSymbols.sort(
      (a, b) => (degrees.get(b.id)?.total ?? 0) - (degrees.get(a.id)?.total ?? 0),
    );

    for (const symNode of rankedCallSymbols) {
      if (includedNodeIds.has(symNode.id)) continue;
      includedNodeIds.add(symNode.id);
      const deg = degrees.get(symNode.id)?.total ?? 0;
      g6Nodes.push({
        id: symNode.id,
        data: {
          label: symbolDisplayLabel(symNode),
          fullLabel: symNode.label,
          nodeKind: 'symbol',
          fullPath: symNode.path,
          symbolKind: symNode.symbol?.kind,
          line: symNode.symbol?.line,
          signature: symNode.symbol?.signature,
          exported: symNode.symbol?.exported,
          async: symNode.symbol?.async,
          isEntry: false,
          inDegree: degrees.get(symNode.id)?.in ?? 0,
          outDegree: degrees.get(symNode.id)?.out ?? 0,
        },
        style: {
          fill: symbolNodeColor(symNode.symbol?.kind ?? ''),
          stroke: symNode.symbol?.exported ? '#f0883e' : '#30363d',
          size: scaleSize(deg, minCSymDeg, maxCSymDeg, 20, 45),
        },
      });
    }

    for (const edge of topCalls) {
      if (!includedNodeIds.has(edge.from) || !includedNodeIds.has(edge.to)) continue;
      const edgeColor = EDGE_COLORS[edge.kind] ?? '#6e7681';
      pushEdge({
        source: edge.from,
        target: edge.to,
        data: { label: edge.kind, kind: edge.kind },
        style: { stroke: edgeColor, lineWidth: 1, endArrow: false },
      });
    }
  }

  const includedEdges = edges.filter((e) => {
    if (e.kind === 'contains') return false;
    if (e.kind === 'calls') return false;
    if (showDeps && (e.kind === 'imports' || e.kind === 'reexports' || e.kind === 'tested_by' || e.kind === 'configures')) return true;
    if (showHierarchy && (e.kind === 'extends' || e.kind === 'implements')) return true;
    return false;
  });

  for (const edge of includedEdges) {
    if (!includedNodeIds.has(edge.from) || !includedNodeIds.has(edge.to)) continue;
    const edgeColor = EDGE_COLORS[edge.kind] ?? '#6e7681';
    const isHierarchy = edge.kind === 'extends' || edge.kind === 'implements';
    pushEdge({
      source: edge.from,
      target: edge.to,
      data: { label: edge.kind, kind: edge.kind },
      style: {
        stroke: edgeColor,
        lineWidth: isHierarchy ? 2 : 1,
        endArrow: edge.kind !== 'calls',
      },
    });
  }

  return { nodes: g6Nodes, edges: g6Edges };
}

interface TooltipInfo {
  x: number;
  y: number;
  label: string;
  fullPath: string;
  nodeKind: 'file' | 'symbol';
  symbolKind?: string;
  line?: number;
  signature?: string;
  exported?: boolean;
  async?: boolean;
  inDegree: number;
  outDegree: number;
}

interface SelectedNodeInfo {
  label: string;
  fullPath: string;
  nodeKind: 'file' | 'symbol';
  language?: string;
  fileType?: string;
  symbolKind?: string;
  line?: number;
  signature?: string;
  exported?: boolean;
  async?: boolean;
  inDegree: number;
  outDegree: number;
  parentFolder?: string;
  isEntry: boolean;
}

interface ProjectGraphKnowledgeGraphProps {
  projectGraph: WorkspaceProjectGraphResult;
  onNodeClick?: (filePath: string, line?: number) => void;
  dark?: boolean;
  viewModes?: Set<string>;
  searchQuery?: string;
  lang?: 'zh-CN' | 'zh-TW' | 'en';
}

export interface ProjectGraphKnowledgeGraphHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  fitView: () => void;
}

function fuzzyMatch(target: string, query: string): boolean {
  if (query.length < 2) return false;
  let qi = 0;
  for (let i = 0; i < target.length && qi < query.length; i++) {
    if (target[i] === query[qi]) {
      qi++;
    }
  }
  return qi === query.length;
}

// 按当前搜索词给图中节点应用 searchDim 状态。抽成独立函数，使得「悬停清除高亮后」也能用当前搜索词
// 重新恢复搜索 dimming（否则悬停一次就会永久抹掉搜索高亮）。使用批量 setElementState 一次性更新，
// 避免对每个节点单独调用（大图下逐个调用会触发大量重绘）。
function applySearchDimming(graph: Graph, query: string): void {
  const q = query.trim().toLowerCase();
  try {
    const allNodes = graph.getNodeData();
    const stateMap: Record<string, string | string[]> = {};
    if (!q) {
      for (const n of allNodes) { if (n.id) stateMap[n.id] = []; }
      void graph.setElementState(stateMap);
      return;
    }
    const matchingIds = new Set<string>();
    const neighborIds = new Set<string>();
    for (const n of allNodes) {
      if (!n.id) continue;
      const data = n.data as G6NodeData | undefined;
      const label = (data?.label ?? '').toLowerCase();
      const fullPath = (data?.fullPath ?? '').toLowerCase();
      if (label.includes(q) || fullPath.includes(q) || fuzzyMatch(label, q) || fuzzyMatch(fullPath, q)) {
        matchingIds.add(n.id);
      }
    }
    if (matchingIds.size === 0) {
      for (const n of allNodes) { if (n.id) stateMap[n.id] = []; }
      void graph.setElementState(stateMap);
      return;
    }
    const allEdges = graph.getEdgeData();
    for (const edge of allEdges) {
      if (edge.source && matchingIds.has(edge.source) && edge.target) neighborIds.add(edge.target);
      if (edge.target && matchingIds.has(edge.target) && edge.source) neighborIds.add(edge.source);
    }
    for (const n of allNodes) {
      if (!n.id) continue;
      stateMap[n.id] = matchingIds.has(n.id) || neighborIds.has(n.id) ? [] : 'searchDim';
    }
    void graph.setElementState(stateMap);
  } catch { /* ignore */ }
}

interface EdgeRelation {
  edgeId: string;
  kind: string;
  direction: 'in' | 'out';
  targetNodeId: string;
  targetLabel: string;
  targetPath: string;
  targetKind: 'file' | 'symbol';
  targetLine?: number;
  targetSymbolKind?: string;
}

interface ConnectedEdges {
  inbound: EdgeRelation[];
  outbound: EdgeRelation[];
}

function computeConnectedEdges(
  nodeId: string | undefined,
  edges: ProjectGraphEdge[],
  nodeMap: Map<string, ProjectGraphNode>,
): ConnectedEdges {
  const result: ConnectedEdges = { inbound: [], outbound: [] };
  if (!nodeId) return result;

  for (const edge of edges) {
    if (edge.kind === 'contains') continue;
    const isOut = edge.from === nodeId;
    const isIn = edge.to === nodeId;
    if (!isOut && !isIn) continue;

    const targetId = isOut ? edge.to : edge.from;
    const targetNode = nodeMap.get(targetId);
    if (!targetNode) continue;

    const rel: EdgeRelation = {
      edgeId: edge.id,
      kind: edge.kind,
      direction: isOut ? 'out' : 'in',
      targetNodeId: targetId,
      targetLabel: targetNode.label,
      targetPath: targetNode.path,
      targetKind: targetNode.kind,
      targetLine: targetNode.symbol?.line,
      targetSymbolKind: targetNode.symbol?.kind,
    };

    if (isOut) {
      result.outbound.push(rel);
    } else {
      result.inbound.push(rel);
    }
  }

  result.inbound.sort((a, b) => a.kind.localeCompare(b.kind) || a.targetLabel.localeCompare(b.targetLabel));
  result.outbound.sort((a, b) => a.kind.localeCompare(b.kind) || a.targetLabel.localeCompare(b.targetLabel));

  return result;
}

const ProjectGraphKnowledgeGraph = forwardRef<
  ProjectGraphKnowledgeGraphHandle,
  ProjectGraphKnowledgeGraphProps
>(function ProjectGraphKnowledgeGraph(
  { projectGraph, onNodeClick, dark = true, viewModes, searchQuery = '', lang },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const onNodeClickRef = useRef(onNodeClick);
  onNodeClickRef.current = onNodeClick;
  const searchQueryRef = useRef(searchQuery);
  searchQueryRef.current = searchQuery;
  // 复用的节点索引与度数表：避免每次点击/导航都重新遍历整张图（O(n+e)）。
  const graphNodeMap = useMemo(
    () => new Map(projectGraph.nodes.map((n) => [n.id, n])),
    [projectGraph.nodes],
  );
  const graphDegrees = useMemo(
    () => computeDegrees(projectGraph.nodes, projectGraph.edges),
    [projectGraph.nodes, projectGraph.edges],
  );
  // 位置缓存：当图数据未变（仅主题切换等导致重建）时，复用上一次的节点坐标并跳过昂贵的力导布局，
  // 避免每次重建都重跑 1200 次迭代。
  const positionsCacheRef = useRef<Map<string, [number, number]> | null>(null);
  const lastGraphRef = useRef<WorkspaceProjectGraphResult | null>(null);
  const lastViewModeKeyRef = useRef<string>('');
  const [tooltipInfo, setTooltipInfo] = useState<TooltipInfo | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<SelectedNodeInfo | null>(null);
  const [connectedEdges, setConnectedEdges] = useState<ConnectedEdges>({ inbound: [], outbound: [] });
  const t = getTranslation(lang ?? 'zh-CN');
  const edgeKindLabel = (kind: string): string => {
    switch (kind) {
      case 'imports': return t.workspaceProjectGraphImports;
      case 'reexports': return t.workspaceProjectGraphReexports;
      case 'extends': return t.workspaceProjectGraphExtends;
      case 'implements': return t.workspaceProjectGraphImplements;
      case 'calls': return lang === 'en' ? 'Calls' : '调用';
      case 'tested_by': return lang === 'en' ? 'Tested By' : '测试';
      case 'configures': return lang === 'en' ? 'Configures' : '配置';
      default: return kind;
    }
  };

  const handleNodeClick = useCallback(
    (filePath: string, line?: number) => {
      onNodeClickRef.current?.(filePath, line);
    },
    [],
  );

  const handleOpenFile = useCallback(() => {
    if (selectedNode) {
      onNodeClickRef.current?.(selectedNode.fullPath, selectedNode.line);
    }
  }, [selectedNode]);

  const navigateToNode = useCallback((targetNodeId: string) => {
    const targetNode = graphNodeMap.get(targetNodeId);
    if (!targetNode) return;

    const fileTypeVal = targetNode.fileType;
    setSelectedNode({
      label: targetNode.qualifiedName ?? targetNode.label,
      fullPath: targetNode.path,
      nodeKind: targetNode.kind,
      language: targetNode.language,
      fileType: fileTypeVal,
      symbolKind: targetNode.symbol?.kind,
      line: targetNode.symbol?.line,
      signature: targetNode.symbol?.signature,
      exported: targetNode.symbol?.exported,
      async: targetNode.symbol?.async,
      inDegree: graphDegrees.get(targetNode.id)?.in ?? 0,
      outDegree: graphDegrees.get(targetNode.id)?.out ?? 0,
      parentFolder: targetNode.path ? parentFolder(targetNode.path) : undefined,
      isEntry: Boolean(targetNode.entryPoint),
    });
    setConnectedEdges(computeConnectedEdges(targetNodeId, projectGraph.edges, graphNodeMap));
    onNodeClickRef.current?.(targetNode.path, targetNode.symbol?.line);
  }, [graphNodeMap, graphDegrees, projectGraph.edges]);

  useImperativeHandle(ref, () => ({
    zoomIn: () => {
      const graph = graphRef.current;
      if (!graph) return;
      graph.zoomTo(graph.getZoom() * 1.3, { duration: 300 });
    },
    zoomOut: () => {
      const graph = graphRef.current;
      if (!graph) return;
      graph.zoomTo(graph.getZoom() / 1.3, { duration: 300 });
    },
    fitView: () => {
      graphRef.current?.fitView();
    },
  }), []);

  const viewModeKey = viewModes ? [...viewModes].sort().join(',') : '_all';

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    setGraphError(null);
    setSelectedNode(null);

    try {
    const { nodes, edges } = buildG6Data(
      projectGraph.nodes,
      projectGraph.edges,
      viewModes,
    );

    if (graphRef.current) {
      graphRef.current.destroy();
      graphRef.current = null;
    }

    // 空图（没有任何节点）时不创建 G6 实例：autoFit:'view' 作用于空数据会产生无效变换/告警。
    // 上层（WorkspaceInsightPanel）会展示「暂无节点」占位，这里直接跳过渲染。
    if (nodes.length === 0) {
      return;
    }

    // 若图数据未变（同一 projectGraph 引用 + 同一视图模式），仅是主题切换等导致重建，
    // 则复用上一次布局得到的节点坐标并跳过昂贵的力导布局（否则每次重建都重跑 1200 次迭代）。
    const canReusePositions =
      positionsCacheRef.current !== null &&
      lastGraphRef.current === projectGraph &&
      lastViewModeKeyRef.current === viewModeKey &&
      nodes.every((n) => {
        const p = positionsCacheRef.current!.get(n.id);
        return !!p && Number.isFinite(p[0]) && Number.isFinite(p[1]);
      });
    if (canReusePositions && positionsCacheRef.current) {
      const cache = positionsCacheRef.current;
      for (const n of nodes) {
        const p = cache.get(n.id);
        if (p) {
          n.style.x = p[0];
          n.style.y = p[1];
        }
      }
    }

    const rect = container.getBoundingClientRect();
    const initWidth = rect.width || 800;
    const initHeight = rect.height || 500;

    const graphOptions: GraphOptions = {
      container,
      autoFit: 'view',
      animation: false,
      data: { nodes, edges },
      node: {
        type: 'circle',
        style: {
          labelText: (d: NodeData) => ((d.data?.label as string) ?? String(d.id)),
          labelPlacement: 'bottom',
          labelFill: dark ? '#e0e0e0' : '#1e1b18',
          labelFontSize: 10,
          labelFontFamily: 'Consolas, monospace',
          labelWordWrap: true,
          labelWordWrapWidth: 100,
          opacity: 1,
        },
        state: {
          highlight: {
            stroke: dark ? '#f0883e' : '#d9673e',
            lineWidth: 3,
          },
          neighbour: {},
          dim: {
            opacity: 0.15,
          },
          searchDim: {
            opacity: 0.15,
          },
        },
      },
      edge: {
        type: 'cubic-horizontal',
        style: {
          strokeOpacity: 0.5,
          endArrow: true,
          opacity: 1,
        },
        state: {
          active: {
            strokeOpacity: 0.9,
            lineWidth: 2,
            labelText: (d: EdgeData) => ((d.data?.label as string) ?? ''),
            labelFontSize: 7,
            labelFill: dark ? '#aaa' : '#5a544c',
            labelBackground: true,
            labelBackgroundFill: dark ? '#10131b' : '#f5f0e9',
            labelBackgroundOpacity: 0.9,
            labelBackgroundRadius: 2,
            labelBackgroundPadding: [1, 3],
          },
          dim: {
            opacity: 0.08,
          },
        },
      },
      // 复用坐标时不下发 layout，G6 会按节点 style.x/y 直接定位，跳过力导计算。
      ...(canReusePositions
        ? {}
        : {
            layout: {
              type: 'force',
              preventOverlap: true,
              nodeSize: (d: NodeData) => {
                const size = d.style?.size as number | undefined;
                return size ?? 30;
              },
              nodeSpacing: 24,
              collideStrength: 1,
              linkDistance: 260,
              nodeStrength: 3000,
              edgeStrength: 0.2,
              clustering: false,
              animation: false,
              maxIteration: 1200,
            },
          }),
      behaviors: [
        'drag-canvas',
        'zoom-canvas',
        {
          type: 'click-select',
          onClick: (event: unknown) => {
            const e = event as { targetType?: string; target?: { id?: string } };
            if (e.targetType !== 'node' || !e.target?.id) return;
            const nodeId = e.target.id;
            const nd = graph.getNodeData(nodeId);
            const g6Data = nd?.data as G6NodeData | undefined;
            if (!g6Data?.fullPath) return;
            setSelectedNode({
              label: g6Data.fullLabel ?? g6Data.label,
              fullPath: g6Data.fullPath,
              nodeKind: g6Data.nodeKind,
              language: g6Data.language,
              fileType: g6Data.fileType,
              symbolKind: g6Data.symbolKind,
              line: g6Data.line,
              signature: g6Data.signature,
              exported: g6Data.exported,
              async: g6Data.async,
              inDegree: g6Data.inDegree,
              outDegree: g6Data.outDegree,
              parentFolder: g6Data.parentFolder,
              isEntry: g6Data.isEntry,
            });
            setConnectedEdges(computeConnectedEdges(nodeId, projectGraph.edges, graphNodeMap));
            handleNodeClick(g6Data.fullPath, g6Data.line);
          },
        },
      ],
    };

    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (gl) {
        graphOptions.canvas = { renderer: () => new WebGLRenderer() };
      }
    } catch { /* fallback to Canvas 2D */ }

    const graph = new Graph(graphOptions);

    // 邻接表惰性构建并缓存：悬停高亮只需查表（O(度数)），避免每次悬停都遍历全部边（O(E)）。
    // 在首次悬停时（此时图已渲染、元素 id 已确定）构建一次。
    let adjacencyCache: {
      nodeIds: string[];
      edgeIds: string[];
      neighbors: Map<string, Set<string>>;
      edgeIdsByNode: Map<string, Set<string>>;
    } | null = null;
    const getAdjacency = () => {
      if (adjacencyCache) return adjacencyCache;
      const neighbors = new Map<string, Set<string>>();
      const edgeIdsByNode = new Map<string, Set<string>>();
      const nodeIds: string[] = [];
      const edgeIds: string[] = [];
      for (const n of graph.getNodeData()) {
        if (!n.id) continue;
        nodeIds.push(n.id);
        neighbors.set(n.id, new Set());
        edgeIdsByNode.set(n.id, new Set());
      }
      for (const ed of graph.getEdgeData()) {
        if (!ed.id || !ed.source || !ed.target) continue;
        edgeIds.push(ed.id);
        neighbors.get(ed.source)?.add(ed.target);
        neighbors.get(ed.target)?.add(ed.source);
        edgeIdsByNode.get(ed.source)?.add(ed.id);
        edgeIdsByNode.get(ed.target)?.add(ed.id);
      }
      adjacencyCache = { nodeIds, edgeIds, neighbors, edgeIdsByNode };
      return adjacencyCache;
    };

    const clearHoverStates = () => {
      if (!graphRef.current) return;
      try {
        // 批量一次性重置所有元素状态，避免逐个调用触发大量重绘。
        const { nodeIds, edgeIds } = getAdjacency();
        const reset: Record<string, string[]> = {};
        for (const id of nodeIds) reset[id] = [];
        for (const id of edgeIds) reset[id] = [];
        void graph.setElementState(reset);
      } catch { /* ignore cleanup errors */ }
      // 悬停会把节点状态重置为空，从而抹掉搜索 dimming；这里用当前搜索词恢复搜索高亮。
      applySearchDimming(graph, searchQueryRef.current);
    };

    graph.on('node:pointerenter', (evt: unknown) => {
      const e = evt as Record<string, unknown>;
      const nodeId = (e as { target?: { id?: string } }).target?.id as string | undefined;
      if (!nodeId || !graphRef.current) return;

      const g = graphRef.current;
      try {
        const { nodeIds, edgeIds, neighbors, edgeIdsByNode } = getAdjacency();
        const nb = neighbors.get(nodeId);
        const ce = edgeIdsByNode.get(nodeId);
        // 汇总成一张状态表后单次批量下发（O(1) 次 setElementState 调用，而非 O(N+E) 次）。
        const stateMap: Record<string, string> = {};
        for (const id of nodeIds) {
          stateMap[id] = id === nodeId ? 'highlight' : nb?.has(id) ? 'neighbour' : 'dim';
        }
        for (const id of edgeIds) {
          stateMap[id] = ce?.has(id) ? 'active' : 'dim';
        }
        void g.setElementState(stateMap);
      } catch { /* ignore */ }

      const canvasPos = (e as { canvas?: { x?: number; y?: number } }).canvas;
      const nodeModel = (e as { target?: { data?: G6NodeData } }).target?.data;

      if (nodeModel) {
        // e.canvas.x/y 是相对于 canvas 元素的坐标，而 tooltip 绝对定位在外层 relative 容器中；
        // canvas 容器位于统计栏下方，需加上其在外层容器中的偏移，否则 tooltip 会整体向上错位。
        const containerEl = containerRef.current;
        const offsetX = containerEl?.offsetLeft ?? 0;
        const offsetY = containerEl?.offsetTop ?? 0;
        setTooltipInfo({
          x: (canvasPos?.x ?? 0) + offsetX + 12,
          y: (canvasPos?.y ?? 0) + offsetY - 10,
          label: nodeModel.fullLabel ?? nodeModel.label,
          fullPath: nodeModel.fullPath,
          nodeKind: nodeModel.nodeKind,
          symbolKind: nodeModel.symbolKind,
          line: nodeModel.line,
          signature: nodeModel.signature,
          exported: nodeModel.exported,
          async: nodeModel.async,
          inDegree: nodeModel.inDegree,
          outDegree: nodeModel.outDegree,
        });
      }
    });

    graph.on('node:pointermove', (evt: unknown) => {
      const e = evt as Record<string, unknown>;
      const canvasPos = (e as { canvas?: { x?: number; y?: number } }).canvas;
      if (canvasPos) {
        // 与 pointerenter 一致，加上 canvas 容器在外层 relative 容器中的偏移，否则移动时 tooltip 会跳变错位。
        const containerEl = containerRef.current;
        const offsetX = containerEl?.offsetLeft ?? 0;
        const offsetY = containerEl?.offsetTop ?? 0;
        setTooltipInfo((prev) =>
          prev
            ? { ...prev, x: canvasPos.x! + offsetX + 12, y: canvasPos.y! + offsetY - 10 }
            : null,
        );
      }
    });

    graph.on('node:pointerleave', () => {
      clearHoverStates();
      setTooltipInfo(null);
    });

    graph.on('canvas:click', (evt: unknown) => {
      const e = evt as { targetType?: string };
      if (e.targetType === 'node' || e.targetType === 'edge') return;
      clearHoverStates();
      setTooltipInfo(null);
      setSelectedNode(null);
      setConnectedEdges({ inbound: [], outbound: [] });
    });

    graph.render().catch((err) => {
      console.error('G6 render error:', err);
      setGraphError(err instanceof Error ? err.message : String(err));
    });

    graphRef.current = graph;

    // 布局完成后缓存节点坐标，供下次「数据未变、仅主题切换等」的重建复用，从而跳过昂贵的力导布局。
    graph.on('afterlayout', () => {
      try {
        const posMap = new Map<string, [number, number]>();
        for (const n of graph.getNodeData()) {
          const style = (n as { style?: { x?: number; y?: number } }).style;
          if (n.id && typeof style?.x === 'number' && typeof style?.y === 'number') {
            posMap.set(n.id, [style.x, style.y]);
          }
        }
        if (posMap.size > 0) positionsCacheRef.current = posMap;
      } catch { /* ignore */ }
    });
    lastGraphRef.current = projectGraph;
    lastViewModeKeyRef.current = viewModeKey;

    graph.setSize(initWidth, initHeight);

    let resizeRaf = 0;
    let lastW = initWidth;
    let lastH = initHeight;
    const handleResize = () => {
      if (!container) return;
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        const { width: w, height: h } = container.getBoundingClientRect();
        const fw = w || 800;
        const fh = h || 500;
        if (fw === lastW && fh === lastH) return;
        if (fw < 10 || fh < 10) return;
        lastW = fw;
        lastH = fh;
        graph.setSize(fw, fh);
      });
    };

    const observer = new ResizeObserver(handleResize);
    observer.observe(container);

    return () => {
      cancelAnimationFrame(resizeRaf);
      observer.disconnect();
      graph.destroy();
      graphRef.current = null;
      setTooltipInfo(null);
    };
    } catch (err) {
      console.error('G6 init error:', err);
      setGraphError(err instanceof Error ? err.message : String(err));
    }
  }, [projectGraph, handleNodeClick, dark, viewModeKey, graphNodeMap]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    applySearchDimming(graph, searchQuery);
  }, [searchQuery, projectGraph, viewModeKey]);

  const summary = projectGraph.summary;

  return (
    <div className="relative flex min-h-0 flex-1 w-full flex-col">
      {graphError && (
        <div className={`m-3 rounded-xl border px-3 py-3 text-xs ${dark ? 'border-red-500/30 bg-red-500/10 text-red-300' : 'border-red-400/30 bg-red-50 text-red-600'}`}>
          知识图谱初始化失败: {graphError}
        </div>
      )}
      {/* 统计摘要 */}
      {!graphError && (
        <div className={`flex flex-wrap gap-1.5 px-1 py-1.5 text-[10px] ${dark ? 'text-slate-400' : 'text-slate-500'}`}>
          <span className={`rounded-full border px-2 py-0.5 ${dark ? 'border-[#2a2d3a] bg-[#1a1d27]' : 'border-slate-200 bg-white'}`}>
            {lang === 'en' ? 'Files' : '文件'} {summary.files}
          </span>
          {(summary.testFiles ?? 0) > 0 && (
            <span className={`rounded-full border px-2 py-0.5 ${dark ? 'border-amber-500/30 bg-amber-500/10 text-amber-400' : 'border-amber-400/30 bg-amber-50 text-amber-600'}`}>
              测试 {(summary.testFiles ?? 0)}
            </span>
          )}
          {(summary.configFiles ?? 0) > 0 && (
            <span className={`rounded-full border px-2 py-0.5 ${dark ? 'border-purple-500/30 bg-purple-500/10 text-purple-400' : 'border-purple-400/30 bg-purple-50 text-purple-600'}`}>
              配置 {(summary.configFiles ?? 0)}
            </span>
          )}
          {(summary.docFiles ?? 0) > 0 && (
            <span className={`rounded-full border px-2 py-0.5 ${dark ? 'border-teal-500/30 bg-teal-500/10 text-teal-400' : 'border-teal-400/30 bg-teal-50 text-teal-600'}`}>
              文档 {(summary.docFiles ?? 0)}
            </span>
          )}
          <span className={`rounded-full border px-2 py-0.5 ${dark ? 'border-[#2a2d3a] bg-[#1a1d27]' : 'border-slate-200 bg-white'}`}>
            {lang === 'en' ? 'Symbols' : '符号'} {summary.symbols}
          </span>
          <span className={`rounded-full border px-2 py-0.5 ${dark ? 'border-[#2a2d3a] bg-[#1a1d27]' : 'border-slate-200 bg-white'}`}>
            {lang === 'en' ? 'Edges' : '边'} {summary.edges}
          </span>
          <span className={`rounded-full border px-2 py-0.5 ${dark ? 'border-[#2a2d3a] bg-[#1a1d27]' : 'border-slate-200 bg-white'}`}>
            {t.workspaceProjectGraphImports} {summary.imports}
          </span>
          <span className={`rounded-full border px-2 py-0.5 ${dark ? 'border-[#2a2d3a] bg-[#1a1d27]' : 'border-slate-200 bg-white'}`}>
            {t.workspaceProjectGraphExtends} {summary.extends}
          </span>
          <span className={`rounded-full border px-2 py-0.5 ${dark ? 'border-[#2a2d3a] bg-[#1a1d27]' : 'border-slate-200 bg-white'}`}>
            {t.workspaceProjectGraphImplements} {summary.implements}
          </span>
          <span className={`rounded-full border px-2 py-0.5 ${dark ? 'border-[#2a2d3a] bg-[#1a1d27]' : 'border-slate-200 bg-white'}`}>
            {lang === 'en' ? 'Calls' : '调用'} {summary.calls}
          </span>
          {(summary.testedBy ?? 0) > 0 && (
            <span className={`rounded-full border px-2 py-0.5 ${dark ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : 'border-emerald-400/30 bg-emerald-50 text-emerald-600'}`}>
              测试覆盖 {summary.testedBy}
            </span>
          )}
          <span className={`rounded-full border px-2 py-0.5 ${dark ? 'border-[#2a2d3a] bg-[#1a1d27]' : 'border-slate-200 bg-white'}`}>
            {lang === 'en' ? 'Entry Points' : '入口点'} {summary.entryPoints}
          </span>
          {summary.lspEnhanced && (
            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-emerald-400">
              LSP
            </span>
          )}
        </div>
      )}
      {/* 图谱 */}
      <div className="flex min-h-0 flex-1">
        {!graphError && (
        <div
          ref={containerRef}
          className={`relative min-h-0 flex-1 overflow-hidden rounded-xl border ${dark ? 'border-[#2a2d3a] bg-[#0d1117]' : 'border-slate-200 bg-[#f5f0e9]'}`}
        >
          {/* 居中详情浮层 */}
          {selectedNode && (
            <div
              className="absolute inset-0 z-20 flex items-center justify-center bg-black/40 backdrop-blur-sm"
              onClick={() => { setSelectedNode(null); setConnectedEdges({ inbound: [], outbound: [] }); }}
            >
              <div
                className={`flex max-h-[75vh] w-[440px] max-w-[92vw] flex-col overflow-y-auto rounded-2xl border p-5 shadow-2xl text-[12px] leading-relaxed ${dark ? 'border-[#2a2d3a] bg-[#1a1d27] text-slate-200' : 'border-slate-200 bg-white text-slate-700'}`}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-500">
                    {lang === 'en' ? 'Node Details' : '节点详情'}
                  </span>
                  <button
                    type="button"
                    onClick={() => { setSelectedNode(null); setConnectedEdges({ inbound: [], outbound: [] }); }}
                    className="text-slate-500 hover:text-slate-300 text-base leading-none"
                  >
                    &times;
                  </button>
                </div>
                <div className="mb-2 font-semibold text-sm break-all">
                  {selectedNode.symbolKind && (
                    <span className={`mr-1.5 rounded px-1.5 py-0.5 text-[10px] uppercase ${dark ? 'bg-[#2a2d3a] text-slate-400' : 'bg-slate-100 text-slate-500'}`}>
                      {selectedNode.symbolKind}
                    </span>
                  )}
                  {selectedNode.exported && <span className="mr-1 text-amber-400" title="exported">★</span>}
                  {selectedNode.async && <span className="mr-1 text-blue-400" title="async">▸</span>}
                  {selectedNode.label}
                </div>
                <div className={`mb-3 rounded px-2.5 py-1.5 font-mono text-[10px] break-all ${dark ? 'bg-[#0d1117] text-slate-400' : 'bg-slate-50 text-slate-500'}`}>
                  {selectedNode.fullPath}
                </div>
                <div className="space-y-1.5 text-[11px]">
                  <div className="flex justify-between">
                    <span className="opacity-50">{lang === 'en' ? 'Type' : '类型'}</span>
                    <span>{selectedNode.nodeKind === 'file' ? (lang === 'en' ? 'File' : '文件') : (lang === 'en' ? 'Symbol' : '符号')}</span>
                  </div>
                  {selectedNode.fileType && selectedNode.fileType !== 'source' && (
                    <div className="flex justify-between">
                      <span className="opacity-50">{lang === 'en' ? 'Category' : '分类'}</span>
                      <span style={{ color: FILE_TYPE_COLORS[selectedNode.fileType] ?? '#8b949e' }}>
                        {selectedNode.fileType === 'test' ? (lang === 'en' ? 'Test' : '测试') :
                         selectedNode.fileType === 'config' ? (lang === 'en' ? 'Config' : '配置') :
                         selectedNode.fileType === 'doc' ? (lang === 'en' ? 'Docs' : '文档') :
                         selectedNode.fileType === 'docker' ? 'Docker' :
                         selectedNode.fileType === 'cicd' ? 'CI/CD' :
                         selectedNode.fileType === 'sql' ? 'SQL' : selectedNode.fileType}
                      </span>
                    </div>
                  )}
                  {selectedNode.language && (
                    <div className="flex justify-between">
                      <span className="opacity-50">{lang === 'en' ? 'Language' : '语言'}</span>
                      <span>{selectedNode.language}</span>
                    </div>
                  )}
                  {selectedNode.line != null && (
                    <div className="flex justify-between">
                      <span className="opacity-50">{lang === 'en' ? 'Line' : '行号'}</span>
                      <span>L{selectedNode.line}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="opacity-50">{lang === 'en' ? 'In-degree' : '入度'}</span>
                    <span className="text-blue-400">↓ {selectedNode.inDegree}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="opacity-50">{lang === 'en' ? 'Out-degree' : '出度'}</span>
                    <span className="text-amber-400">↑ {selectedNode.outDegree}</span>
                  </div>
                  {selectedNode.isEntry && (
                    <div className="flex justify-between">
                      <span className="opacity-50">{lang === 'en' ? 'Entry' : '入口'}</span>
                      <span className="text-emerald-400">✓</span>
                    </div>
                  )}
                </div>
                {selectedNode.signature && (
                  <div className={`mt-3 rounded px-2.5 py-1.5 font-mono text-[10px] leading-relaxed break-all ${dark ? 'bg-[#0d1117] text-slate-300' : 'bg-slate-50 text-slate-600'}`}>
                    {selectedNode.signature}
                  </div>
                )}
                {connectedEdges.inbound.length > 0 && (
                  <div className="mt-3">
                    <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                      {lang === 'en' ? 'Dependents' : '被依赖'} ({connectedEdges.inbound.length})
                    </div>
                    <div className="flex flex-col gap-0.5 max-h-36 overflow-y-auto">
                      {connectedEdges.inbound.map((rel) => (
                        <button
                          key={rel.edgeId}
                          type="button"
                          onClick={() => navigateToNode(rel.targetNodeId)}
                          className={`flex items-center gap-1.5 rounded px-2 py-1 text-[10px] text-left transition-colors ${dark ? 'hover:bg-[#2a2d3a]' : 'hover:bg-slate-100'}`}
                        >
                          <span className="inline-block h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: EDGE_COLORS[rel.kind] ?? '#6e7681' }} />
                          <span className="shrink-0 text-[10px] opacity-60">{edgeKindLabel(rel.kind)}</span>
                          <span className="truncate">{rel.targetLabel}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {connectedEdges.outbound.length > 0 && (
                  <div className="mt-2">
                    <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                      {lang === 'en' ? 'Depends On' : '依赖'} ({connectedEdges.outbound.length})
                    </div>
                    <div className="flex flex-col gap-0.5 max-h-36 overflow-y-auto">
                      {connectedEdges.outbound.map((rel) => (
                        <button
                          key={rel.edgeId}
                          type="button"
                          onClick={() => navigateToNode(rel.targetNodeId)}
                          className={`flex items-center gap-1.5 rounded px-2 py-1 text-[10px] text-left transition-colors ${dark ? 'hover:bg-[#2a2d3a]' : 'hover:bg-slate-100'}`}
                        >
                          <span className="inline-block h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: EDGE_COLORS[rel.kind] ?? '#6e7681' }} />
                          <span className="shrink-0 text-[10px] opacity-60">{edgeKindLabel(rel.kind)}</span>
                          <span className="truncate">{rel.targetLabel}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <button
                  type="button"
                  onClick={handleOpenFile}
                  className={`mt-4 w-full rounded-lg border px-3 py-2 text-[11px] font-medium transition-colors ${dark ? 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300 hover:bg-indigo-500/20' : 'border-indigo-300 bg-indigo-50 text-indigo-600 hover:bg-indigo-100'}`}
                >
                  {lang === 'en' ? 'Open File' : '打开文件'}
                </button>
              </div>
            </div>
          )}
        </div>
        )}
      </div>
      {tooltipInfo && (
        <div
          className={`pointer-events-none absolute z-30 max-w-[320px] rounded-lg border px-2.5 py-2 text-[10px] leading-relaxed shadow-lg ${dark ? 'border-[#2a2d3a] bg-[#1a1d27] text-slate-200' : 'border-slate-200 bg-white text-slate-700'}`}
          style={{ left: tooltipInfo.x, top: tooltipInfo.y }}
        >
          <div className="mb-1 font-semibold">
            {tooltipInfo.nodeKind === 'symbol' && tooltipInfo.symbolKind && (
              <span className={`mr-1 rounded px-1 py-0.5 text-[8px] uppercase ${dark ? 'bg-[#2a2d3a] text-slate-400' : 'bg-slate-100 text-slate-500'}`}>
                {tooltipInfo.symbolKind}
              </span>
            )}
            {tooltipInfo.exported && <span className="mr-1 text-amber-400" title="exported">★</span>}
            {tooltipInfo.async && <span className="mr-1 text-blue-400" title="async">▸</span>}
            {tooltipInfo.label}
          </div>
          <div className="text-[9px] opacity-60">{tooltipInfo.fullPath}</div>
          {tooltipInfo.line != null && (
            <div className="text-[9px] opacity-60">L{tooltipInfo.line}</div>
          )}
          {tooltipInfo.signature && (
            <div className={`mt-1 rounded px-1.5 py-0.5 font-mono text-[9px] ${dark ? 'bg-[#0d1117] text-slate-300' : 'bg-slate-50 text-slate-600'}`}>
              {tooltipInfo.signature}
            </div>
          )}
          <div className="mt-1 flex gap-3 text-[9px] opacity-50">
            <span>↑ {tooltipInfo.outDegree}</span>
            <span>↓ {tooltipInfo.inDegree}</span>
          </div>
        </div>
      )}
      <div className={`pointer-events-none absolute bottom-2 right-2 rounded-lg border px-2.5 py-2 text-[9px] leading-relaxed ${dark ? 'border-[#2a2d3a] bg-[#1a1d27]/90 text-slate-400' : 'border-slate-200 bg-white/90 text-slate-500'}`}>
        <div className="mb-1.5 font-semibold opacity-70">图例</div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          {(['imports', 'reexports', 'extends', 'implements', 'calls', 'tested_by', 'configures'] as const).map((kind) => (
            <div key={kind} className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: EDGE_COLORS[kind] }} />
              <span>{edgeKindLabel(kind)}</span>
            </div>
          ))}
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-full border-2" style={{ borderColor: '#f0883e' }} />
            <span>{lang === 'en' ? 'Entry / Exported' : '入口 / 导出'}</span>
          </div>
        </div>
      </div>
    </div>
  );
});

export default ProjectGraphKnowledgeGraph;
