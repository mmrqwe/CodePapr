import { forwardRef, useEffect, useImperativeHandle, useRef, useCallback, useState } from 'react';
import { Graph } from '@antv/g6';
import type { GraphOptions, NodeData, EdgeData, IElementEvent } from '@antv/g6';
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

const FOLDER_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316',
  '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82b6',
  '#a855f7', '#db2777', '#ea580c', '#ca8a04', '#16a34a',
];

function topFolder(filePath: string): string {
  const segments = filePath.replace(/\\/g, '/').split('/');
  if (segments.length <= 1) return '.';
  return segments.slice(0, -1).join('/');
}

function topFolderColor(folder: string): string {
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
  symbolKind?: string;
  line?: number;
  signature?: string;
  exported?: boolean;
  async?: boolean;
  inDegree: number;
  outDegree: number;
  topFolder?: string;
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
    const folder = topFolder(fileNode.path);

    g6Nodes.push({
      id: fileNode.id,
      data: {
        label: fileNameFromPath(fileNode.path),
        fullLabel: fileNode.path.replace(/\\/g, '/').split('/').pop() ?? fileNode.path,
        nodeKind: 'file',
        fullPath: fileNode.path,
        language: fileNode.language,
        isEntry,
        inDegree: degrees.get(fileNode.id)?.in ?? 0,
        outDegree: degrees.get(fileNode.id)?.out ?? 0,
        topFolder: folder,
      },
      style: {
        fill: topFolderColor(folder),
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
    if (showDeps && (e.kind === 'imports' || e.kind === 'reexports')) return true;
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
  symbolKind?: string;
  line?: number;
  signature?: string;
  exported?: boolean;
  async?: boolean;
  inDegree: number;
  outDegree: number;
  topFolder?: string;
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

const ProjectGraphKnowledgeGraph = forwardRef<
  ProjectGraphKnowledgeGraphHandle,
  ProjectGraphKnowledgeGraphProps
>(function ProjectGraphKnowledgeGraph(
  { projectGraph, onNodeClick, dark = true, viewModes, searchQuery = '', lang },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const [tooltipInfo, setTooltipInfo] = useState<TooltipInfo | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<SelectedNodeInfo | null>(null);
  const t = getTranslation(lang ?? 'zh-CN');
  const edgeKindLabel = (kind: string): string => {
    switch (kind) {
      case 'imports': return t.workspaceProjectGraphImports;
      case 'reexports': return t.workspaceProjectGraphReexports;
      case 'extends': return t.workspaceProjectGraphExtends;
      case 'implements': return t.workspaceProjectGraphImplements;
      case 'calls': return lang === 'en' ? 'Calls' : '调用';
      default: return kind;
    }
  };

  const handleNodeClick = useCallback(
    (filePath: string, line?: number) => {
      onNodeClick?.(filePath, line);
    },
    [onNodeClick],
  );

  const handleOpenFile = useCallback(() => {
    if (selectedNode) {
      onNodeClick?.(selectedNode.fullPath, selectedNode.line);
    }
  }, [selectedNode, onNodeClick]);

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
      behaviors: [
        'drag-canvas',
        'zoom-canvas',
        'drag-element',
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

    graph.on('node:click', (evt: IElementEvent) => {
      const eventData = (evt as IElementEvent & { data: NodeData }).data;
      const nodeData = eventData?.data as G6NodeData | undefined;
      if (nodeData?.fullPath) {
        setSelectedNode({
          label: nodeData.fullLabel ?? nodeData.label,
          fullPath: nodeData.fullPath,
          nodeKind: nodeData.nodeKind,
          language: nodeData.language,
          symbolKind: nodeData.symbolKind,
          line: nodeData.line,
          signature: nodeData.signature,
          exported: nodeData.exported,
          async: nodeData.async,
          inDegree: nodeData.inDegree,
          outDegree: nodeData.outDegree,
          topFolder: nodeData.topFolder,
          isEntry: nodeData.isEntry,
        });
      }
    });

    const clearHoverStates = () => {
      if (!graphRef.current) return;
      try {
        const allNodeData = graph.getNodeData();
        const allEdgeData = graph.getEdgeData();
        for (const n of allNodeData) { if (n.id) graph.setElementState(n.id, []); }
        for (const e of allEdgeData) { if (e.id) graph.setElementState(e.id, []); }
      } catch { /* ignore cleanup errors */ }
    };

    graph.on('node:pointerenter', (evt: unknown) => {
      const e = evt as Record<string, unknown>;
      const nodeId = (e as { target?: { id?: string } }).target?.id as string | undefined;
      if (!nodeId || !graphRef.current) return;

      const g = graphRef.current;
      try {
        const allNodes = g.getNodeData();
        const allEdges = g.getEdgeData();
        const neighborSet = new Set<string>();
        const connectingEdgeIds = new Set<string>();

        for (const edge of allEdges) {
          if (edge.source === nodeId && edge.target) {
            neighborSet.add(edge.target);
            if (edge.id) connectingEdgeIds.add(edge.id);
          } else if (edge.target === nodeId && edge.source) {
            neighborSet.add(edge.source);
            if (edge.id) connectingEdgeIds.add(edge.id);
          }
        }

        for (const n of allNodes) {
          if (!n.id) continue;
          if (n.id === nodeId) {
            g.setElementState(n.id, 'highlight');
          } else if (neighborSet.has(n.id)) {
            g.setElementState(n.id, 'neighbour');
          } else {
            g.setElementState(n.id, 'dim');
          }
        }

        for (const edge of allEdges) {
          if (!edge.id) continue;
          g.setElementState(edge.id, connectingEdgeIds.has(edge.id) ? 'active' : 'dim');
        }
      } catch { /* ignore */ }

      const canvasPos = (e as { canvas?: { x?: number; y?: number } }).canvas;
      const nodeModel = (e as { target?: { data?: G6NodeData } }).target?.data;

      if (nodeModel) {
        setTooltipInfo({
          x: (canvasPos?.x ?? 0) + 12,
          y: (canvasPos?.y ?? 0) - 10,
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
        setTooltipInfo((prev) =>
          prev
            ? { ...prev, x: canvasPos.x! + 12, y: canvasPos.y! - 10 }
            : null,
        );
      }
    });

    graph.on('node:pointerleave', () => {
      clearHoverStates();
      setTooltipInfo(null);
    });

    graph.on('canvas:click', () => {
      clearHoverStates();
      setTooltipInfo(null);
      setSelectedNode(null);
    });

    graph.render().catch((err) => {
      console.error('G6 render error:', err);
    });

    graphRef.current = graph;

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
  }, [projectGraph, handleNodeClick, dark, viewModeKey]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;

    const q = searchQuery.trim().toLowerCase();
    try {
      const allNodes = graph.getNodeData();
      if (!q) {
        for (const n of allNodes) { if (n.id) graph.setElementState(n.id, []); }
        return;
      }
      const matchingIds = new Set<string>();
      const neighborIds = new Set<string>();
      for (const n of allNodes) {
        if (!n.id) continue;
        const data = n.data as G6NodeData | undefined;
        const label = (data?.label ?? '').toLowerCase();
        const fullPath = (data?.fullPath ?? '').toLowerCase();
        if (label.includes(q) || fullPath.includes(q)) {
          matchingIds.add(n.id);
        }
      }
      if (matchingIds.size === 0) {
        for (const n of allNodes) { if (n.id) graph.setElementState(n.id, []); }
        return;
      }
      const allEdges = graph.getEdgeData();
      for (const edge of allEdges) {
        if (edge.source && matchingIds.has(edge.source) && edge.target) neighborIds.add(edge.target);
        if (edge.target && matchingIds.has(edge.target) && edge.source) neighborIds.add(edge.source);
      }
      for (const n of allNodes) {
        if (!n.id) continue;
        if (matchingIds.has(n.id) || neighborIds.has(n.id)) {
          graph.setElementState(n.id, []);
        } else {
          graph.setElementState(n.id, 'searchDim');
        }
      }
    } catch { /* ignore */ }
  }, [searchQuery]);

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
      {/* 图谱 + 详情面板 */}
      <div className="flex min-h-0 flex-1 gap-2">
        {!graphError && (
        <div
          ref={containerRef}
          className={`min-h-0 flex-1 overflow-hidden rounded-xl border ${dark ? 'border-[#2a2d3a] bg-[#0d1117]' : 'border-slate-200 bg-[#f5f0e9]'}`}
        />
        )}
        {/* 详情面板 */}
        {selectedNode && (
          <div className={`flex w-64 shrink-0 flex-col rounded-xl border p-3 text-[11px] leading-relaxed ${dark ? 'border-[#2a2d3a] bg-[#1a1d27] text-slate-200' : 'border-slate-200 bg-white text-slate-700'}`}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-slate-500">
                {lang === 'en' ? 'Details' : '详情'}
              </span>
              <button
                type="button"
                onClick={() => setSelectedNode(null)}
                className="text-slate-500 hover:text-slate-300 text-sm leading-none"
              >
                &times;
              </button>
            </div>
            <div className="mb-2 font-semibold text-xs break-all">
              {selectedNode.symbolKind && (
                <span className={`mr-1.5 rounded px-1 py-0.5 text-[9px] uppercase ${dark ? 'bg-[#2a2d3a] text-slate-400' : 'bg-slate-100 text-slate-500'}`}>
                  {selectedNode.symbolKind}
                </span>
              )}
              {selectedNode.exported && <span className="mr-1 text-amber-400" title="exported">★</span>}
              {selectedNode.async && <span className="mr-1 text-blue-400" title="async">▸</span>}
              {selectedNode.label}
            </div>
            <div className={`mb-1.5 rounded px-2 py-1 font-mono text-[9px] break-all ${dark ? 'bg-[#0d1117] text-slate-400' : 'bg-slate-50 text-slate-500'}`}>
              {selectedNode.fullPath}
            </div>
            <div className="space-y-1 text-[10px]">
              <div className="flex justify-between">
                <span className="opacity-50">{lang === 'en' ? 'Type' : '类型'}</span>
                <span>{selectedNode.nodeKind === 'file' ? (lang === 'en' ? 'File' : '文件') : (lang === 'en' ? 'Symbol' : '符号')}</span>
              </div>
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
              {selectedNode.topFolder && (
                <div className="flex justify-between">
                  <span className="opacity-50">{lang === 'en' ? 'Folder' : '目录'}</span>
                  <span className="text-[9px] truncate max-w-[130px] text-right">{selectedNode.topFolder}</span>
                </div>
              )}
            </div>
            {selectedNode.signature && (
              <div className={`mt-2 rounded px-2 py-1.5 font-mono text-[9px] leading-relaxed break-all ${dark ? 'bg-[#0d1117] text-slate-300' : 'bg-slate-50 text-slate-600'}`}>
                {selectedNode.signature}
              </div>
            )}
            <button
              type="button"
              onClick={handleOpenFile}
              className={`mt-3 w-full rounded-md border px-3 py-1.5 text-[10px] font-medium transition-colors ${dark ? 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300 hover:bg-indigo-500/20' : 'border-indigo-300 bg-indigo-50 text-indigo-600 hover:bg-indigo-100'}`}
            >
              {lang === 'en' ? 'Open File' : '打开文件'}
            </button>
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
          {(['imports', 'reexports', 'extends', 'implements', 'calls'] as const).map((kind) => (
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
