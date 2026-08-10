import { describe, expect, it } from 'vitest';
import {
  buildFileTree,
  collectAncestorDirectories,
  collectDirectoryPaths,
  flattenVisibleFileTree,
  hasSamePathSet,
} from './fileTree';

describe('fileTree', () => {
  it('builds a nested tree with directories before files', () => {
    const tree = buildFileTree([
      { path: 'src/utils', name: 'utils', isDir: true, bytes: 0 },
      { path: 'README.md', name: 'README.md', isDir: false, bytes: 1200 },
      { path: 'src', name: 'src', isDir: true, bytes: 0 },
      { path: 'src/App.tsx', name: 'App.tsx', isDir: false, bytes: 640 },
      { path: 'src/utils/tree.ts', name: 'tree.ts', isDir: false, bytes: 128 },
    ]);

    expect(tree.map((node) => node.path)).toEqual(['src', 'README.md']);
    expect(tree[0]?.children.map((node) => node.path)).toEqual(['src/utils', 'src/App.tsx']);
    expect(tree[0]?.children[0]?.children.map((node) => node.path)).toEqual(['src/utils/tree.ts']);
  });

  it('collects ancestor directories for nested files', () => {
    expect(collectAncestorDirectories('src/components/ChatPanel.tsx')).toEqual([
      'src',
      'src/components',
    ]);
    expect(collectAncestorDirectories('README.md')).toEqual([]);
  });

  it('collects sorted directory paths and compares path sets', () => {
    const directories = collectDirectoryPaths([
      { path: 'src/components', name: 'components', isDir: true, bytes: 0 },
      { path: 'src', name: 'src', isDir: true, bytes: 0 },
      { path: 'README.md', name: 'README.md', isDir: false, bytes: 1 },
    ]);

    expect(directories).toEqual(['src', 'src/components']);
    expect(hasSamePathSet(['src', 'src/components'], ['src/components', 'src'])).toBe(true);
    expect(hasSamePathSet(['src'], ['src/components', 'src'])).toBe(false);
  });

  it('flattens only visible rows based on expanded directories', () => {
    const tree = buildFileTree([
      { path: 'src', name: 'src', isDir: true, bytes: 0 },
      { path: 'src/components', name: 'components', isDir: true, bytes: 0 },
      { path: 'src/components/ChatPanel.tsx', name: 'ChatPanel.tsx', isDir: false, bytes: 1 },
      { path: 'src/App.tsx', name: 'App.tsx', isDir: false, bytes: 1 },
      { path: 'README.md', name: 'README.md', isDir: false, bytes: 1 },
    ]);

    expect(flattenVisibleFileTree(tree, new Set())).toEqual([
      {
        path: 'src',
        name: 'src',
        isDir: true,
        depth: 0,
        parentPath: null,
        hasChildren: true,
      },
      {
        path: 'README.md',
        name: 'README.md',
        isDir: false,
        depth: 0,
        parentPath: null,
        hasChildren: false,
      },
    ]);

    expect(flattenVisibleFileTree(tree, new Set(['src', 'src/components']))).toEqual([
      {
        path: 'src',
        name: 'src',
        isDir: true,
        depth: 0,
        parentPath: null,
        hasChildren: true,
      },
      {
        path: 'src/components',
        name: 'components',
        isDir: true,
        depth: 1,
        parentPath: 'src',
        hasChildren: true,
      },
      {
        path: 'src/components/ChatPanel.tsx',
        name: 'ChatPanel.tsx',
        isDir: false,
        depth: 2,
        parentPath: 'src/components',
        hasChildren: false,
      },
      {
        path: 'src/App.tsx',
        name: 'App.tsx',
        isDir: false,
        depth: 1,
        parentPath: 'src',
        hasChildren: false,
      },
      {
        path: 'README.md',
        name: 'README.md',
        isDir: false,
        depth: 0,
        parentPath: null,
        hasChildren: false,
      },
    ]);
  });

  it('propagates backend hasChildren so unloaded directories show an expand affordance', () => {
    const tree = buildFileTree([
      { path: 'src', name: 'src', isDir: true, bytes: 0, hasChildren: true },
      { path: 'empty', name: 'empty', isDir: true, bytes: 0, hasChildren: false },
      { path: 'README.md', name: 'README.md', isDir: false, bytes: 1, hasChildren: false },
    ]);

    expect(flattenVisibleFileTree(tree, new Set())).toEqual([
      {
        path: 'empty',
        name: 'empty',
        isDir: true,
        depth: 0,
        parentPath: null,
        hasChildren: false,
      },
      {
        path: 'src',
        name: 'src',
        isDir: true,
        depth: 0,
        parentPath: null,
        hasChildren: true,
      },
      {
        path: 'README.md',
        name: 'README.md',
        isDir: false,
        depth: 0,
        parentPath: null,
        hasChildren: false,
      },
    ]);
  });
});