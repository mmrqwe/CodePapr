import { describe, expect, it } from 'vitest';
import {
  filterDeclaredModuleResolutionDiagnostics,
  normalizeImportSpecifierToPackageName,
  parseDeclaredModuleNames,
  parseWorkspacePackageJsonPaths,
} from './editorWorkspaceModules';

describe('parseDeclaredModuleNames', () => {
  it('collects package and dependency names from the main package sections', () => {
    expect(
      parseDeclaredModuleNames(
        JSON.stringify({
          name: '@codepapr/ui',
          dependencies: { react: '^18.0.0' },
          devDependencies: { vite: '^6.0.0', '@vitejs/plugin-react': '^4.0.0' },
          peerDependencies: { marked: '^14.0.0' },
          optionalDependencies: { fsevents: '^2.0.0' },
        })
      )
    ).toEqual(['@codepapr/ui', '@vitejs/plugin-react', 'fsevents', 'marked', 'react', 'vite']);
  });

  it('merges workspace package names into the declared module set', () => {
    expect(
      parseDeclaredModuleNames(
        JSON.stringify({
          name: 'codepapr',
          dependencies: { react: '^18.0.0' },
        }),
        [
          JSON.stringify({ name: '@codepapr/core' }),
          JSON.stringify({ name: '@codepapr/ui', dependencies: { zustand: '^5.0.0' } }),
        ]
      )
    ).toEqual(['@codepapr/core', '@codepapr/ui', 'codepapr', 'react', 'zustand']);
  });

  it('returns an empty list for invalid json', () => {
    expect(parseDeclaredModuleNames('{ nope')).toEqual([]);
  });
});

describe('parseWorkspacePackageJsonPaths', () => {
  it('collects explicit workspace package.json paths and ignores globs', () => {
    expect(
      parseWorkspacePackageJsonPaths(
        JSON.stringify({
          workspaces: [
            'packages/@codepapr/core',
            './packages/@codepapr/ui/',
            'packages/*',
            'tools/**',
          ],
        })
      )
    ).toEqual([
      'packages/@codepapr/core/package.json',
      'packages/@codepapr/ui/package.json',
    ]);
  });
});

describe('normalizeImportSpecifierToPackageName', () => {
  it.each([
    ['vite', 'vite'],
    ['vite/client', 'vite'],
    ['@vitejs/plugin-react', '@vitejs/plugin-react'],
    ['@scope/pkg/subpath', '@scope/pkg'],
    ['node:path', 'node:path'],
    ['./local', null],
    ['/rooted', null],
  ])('maps %s to %s', (input, expected) => {
    expect(normalizeImportSpecifierToPackageName(input)).toBe(expected);
  });
});

describe('filterDeclaredModuleResolutionDiagnostics', () => {
  it('drops unresolved package markers when the package is declared in package.json', () => {
    const markers = [
      { message: "Cannot find module 'vite' or its corresponding type declarations." },
      { message: "Cannot find module '@vitejs/plugin-react' or its corresponding type declarations." },
      { message: "Cannot find module './local-helper' or its corresponding type declarations." },
      { message: "Other error" },
    ];

    expect(
      filterDeclaredModuleResolutionDiagnostics(markers, ['vite', '@vitejs/plugin-react'])
    ).toEqual([
      { message: "Cannot find module './local-helper' or its corresponding type declarations." },
      { message: 'Other error' },
    ]);
  });
});