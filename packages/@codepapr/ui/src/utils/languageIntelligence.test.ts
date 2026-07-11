import { afterEach, describe, expect, it } from 'vitest';
import {
  clearLanguageIntelligenceWorkspace,
  getCachedLanguageIntelligence,
  scheduleLanguageIntelligenceRefresh,
} from './languageIntelligence';

async function waitForCondition(predicate: () => boolean, maxPasses: number = 20): Promise<void> {
  for (let pass = 0; pass < maxPasses; pass += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('languageIntelligence', () => {
  afterEach(() => {
    clearLanguageIntelligenceWorkspace('/tmp/codepapr-lsp-workspace');
  });

  it('caches diagnostics for other files pushed by a workspace-aware LSP server', async () => {
    const workspacePath = '/tmp/codepapr-lsp-workspace';
    const invoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command === 'read_text_file') {
        return {
          path: args?.relativePath,
          content: 'export const value = 1;\n',
          bytes: 24,
        } as T;
      }

      if (command === 'lsp_open_document') {
        return {
          message: {
            opened: true,
            diagnostics: [],
            workspaceDiagnostics: [
              {
                uri: `file://${workspacePath}/src/Consumer.ts`,
                diagnostics: [
                  {
                    severity: 1,
                    message: 'Property getUserAge does not exist',
                    source: 'typescript',
                    range: {
                      start: { line: 4, character: 10 },
                      end: { line: 4, character: 20 },
                    },
                  },
                ],
              },
            ],
            server: {
              languageId: 'typescript',
              serverFamily: 'typescript',
              running: true,
              command: 'typescript-language-server --stdio',
              toolOrigin: 'managed',
              toolSource: 'workspace',
              toolLabel: 'typescript-language-server',
              managedCachePath: null,
              pid: 42,
              openDocuments: 1,
              stderrTail: [],
            },
          },
        } as T;
      }

      if (command === 'lsp_request') {
        return { message: { result: [] } } as T;
      }

      throw new Error(`unexpected command ${command}`);
    };

    scheduleLanguageIntelligenceRefresh({
      invoke,
      workspacePath,
      paths: ['src/UserService.ts'],
      force: true,
    });

    await waitForCondition(
      () => getCachedLanguageIntelligence(workspacePath, 'src/Consumer.ts')?.status === 'ready'
    );

    const consumerSnapshot = getCachedLanguageIntelligence(workspacePath, 'src/Consumer.ts');
    expect(consumerSnapshot).toMatchObject({
      relativePath: 'src/Consumer.ts',
      status: 'ready',
      diagnostics: 1,
    });
    expect(consumerSnapshot?.markers[0]).toMatchObject({
      severity: 'error',
      message: 'Property getUserAge does not exist',
      startLineNumber: 5,
      startColumn: 11,
    });
  });
});