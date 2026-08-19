import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceProjectGraph,
  buildWorkspaceProjectMapSync,
} from './workspaceProjectGraphShared';

describe('workspaceProjectGraphShared', () => {
  it('uses one builder for worker and main-thread fallback', () => {
    const params = {
      rootRelativePath: '',
      entries: [
        { path: 'src', name: 'src', isDir: true, bytes: 0 },
        { path: 'src/main.ts', name: 'main.ts', isDir: false, bytes: 40 },
        { path: 'src/utils.ts', name: 'utils.ts', isDir: false, bytes: 40 },
      ],
      fileContents: {
        'src/main.ts': {
          content: 'export function main() { return 1; }\n',
          bytes: 36,
        },
        'src/utils.ts': {
          content: 'export function helper() { return 2; }\n',
          bytes: 38,
        },
      },
      symbolOverrides: {},
      maxTreeEntries: 40,
      maxStubsPerFile: 8,
      truncated: false,
    };

    const projectMap = buildWorkspaceProjectMapSync(params);
    const graph = buildWorkspaceProjectGraph({
      projectMap,
      entries: params.entries,
      fileContents: params.fileContents,
      symbolOverrides: params.symbolOverrides,
      maxEdges: 50,
    });

    const again = buildWorkspaceProjectGraph({
      projectMap: buildWorkspaceProjectMapSync(params),
      entries: params.entries,
      fileContents: params.fileContents,
      symbolOverrides: params.symbolOverrides,
      maxEdges: 50,
    });

    expect(graph).toEqual(again);
    expect(graph.files.find((file) => file.path === 'src/main.ts')?.entryPoint).toBe(true);
    expect(graph.files.find((file) => file.path === 'src/utils.ts')?.entryPoint).toBeFalsy();
  });
});
