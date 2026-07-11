export interface FileTreeEntryLike {
  path: string;
  name: string;
  isDir: boolean;
  bytes: number;
}

export interface FileTreeNode {
  path: string;
  name: string;
  isDir: boolean;
  bytes: number;
  children: FileTreeNode[];
}

export interface VisibleFileTreeRow {
  path: string;
  name: string;
  isDir: boolean;
  depth: number;
  parentPath: string | null;
  hasChildren: boolean;
}

function compareNames(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function compareNodes(left: FileTreeNode, right: FileTreeNode): number {
  if (left.isDir !== right.isDir) {
    return left.isDir ? -1 : 1;
  }

  return compareNames(left.name, right.name);
}

function pathDepth(path: string): number {
  return path.split('/').filter(Boolean).length;
}

function sortNodes(nodes: FileTreeNode[]): void {
  nodes.sort(compareNodes);
  for (const node of nodes) {
    if (node.children.length > 0) {
      sortNodes(node.children);
    }
  }
}

export function buildFileTree(entries: readonly FileTreeEntryLike[]): FileTreeNode[] {
  const nodesByPath = new Map<string, FileTreeNode>();
  const rootNodes: FileTreeNode[] = [];
  const sortedEntries = [...entries].sort((left, right) => {
    const depthDiff = pathDepth(left.path) - pathDepth(right.path);
    if (depthDiff !== 0) {
      return depthDiff;
    }

    if (left.isDir !== right.isDir) {
      return left.isDir ? -1 : 1;
    }

    return compareNames(left.path, right.path);
  });

  for (const entry of sortedEntries) {
    const node: FileTreeNode = {
      path: entry.path,
      name: entry.name,
      isDir: entry.isDir,
      bytes: entry.bytes,
      children: [],
    };
    nodesByPath.set(entry.path, node);

    const lastSlashIndex = entry.path.lastIndexOf('/');
    const parentPath = lastSlashIndex >= 0 ? entry.path.slice(0, lastSlashIndex) : '';
    const parentNode = parentPath ? nodesByPath.get(parentPath) : undefined;

    if (parentNode) {
      parentNode.children.push(node);
    } else {
      rootNodes.push(node);
    }
  }

  sortNodes(rootNodes);
  return rootNodes;
}

function appendVisibleRows(
  rows: VisibleFileTreeRow[],
  nodes: readonly FileTreeNode[],
  expandedPaths: ReadonlySet<string>,
  depth: number,
  parentPath: string | null
): void {
  for (const node of nodes) {
    rows.push({
      path: node.path,
      name: node.name,
      isDir: node.isDir,
      depth,
      parentPath,
      hasChildren: node.children.length > 0,
    });

    if (node.isDir && node.children.length > 0 && expandedPaths.has(node.path)) {
      appendVisibleRows(rows, node.children, expandedPaths, depth + 1, node.path);
    }
  }
}

export function flattenVisibleFileTree(
  nodes: readonly FileTreeNode[],
  expandedPaths: ReadonlySet<string>
): VisibleFileTreeRow[] {
  const rows: VisibleFileTreeRow[] = [];
  appendVisibleRows(rows, nodes, expandedPaths, 0, null);
  return rows;
}

export function collectAncestorDirectories(path: string): string[] {
  const segments = path.split('/').filter(Boolean);
  if (segments.length <= 1) {
    return [];
  }

  const ancestors: string[] = [];
  let currentPath = '';

  for (let index = 0; index < segments.length - 1; index += 1) {
    currentPath = currentPath ? `${currentPath}/${segments[index]}` : segments[index];
    ancestors.push(currentPath);
  }

  return ancestors;
}

export function collectDirectoryPaths(entries: readonly FileTreeEntryLike[]): string[] {
  return [...entries]
    .filter((entry) => entry.isDir)
    .map((entry) => entry.path)
    .sort(compareNames);
}

export function hasSamePathSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const leftSet = new Set(left);
  return right.every((path) => leftSet.has(path));
}