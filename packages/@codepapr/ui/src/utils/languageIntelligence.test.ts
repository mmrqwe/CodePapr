import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearLanguageIntelligenceWorkspace,
  getCachedLanguageIntelligence,
  LANGUAGE_INTELLIGENCE_DIAGNOSTIC_POLL_DELAYS_MS,
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
    clearLanguageIntelligenceWorkspace('C:/proj');
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

  it('maps Windows file:///C:/… workspace diagnostics back to a relative path', async () => {
    const workspacePath = 'C:/proj';
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
                uri: 'file:///C:/proj/src/Consumer.ts',
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

    expect(getCachedLanguageIntelligence(workspacePath, 'src/Consumer.ts')).toMatchObject({
      relativePath: 'src/Consumer.ts',
      status: 'ready',
      diagnostics: 1,
    });
  });

  it('stops polling a clean file after two empty diagnostic checks', async () => {
    vi.useFakeTimers();
    const workspacePath = '/tmp/codepapr-lsp-workspace';
    let pollCount = 0;
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
            workspaceDiagnostics: [],
            server: {
              languageId: 'typescript',
              serverFamily: 'typescript',
              running: true,
              command: 'typescript-language-server --stdio',
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

      if (command === 'lsp_get_diagnostics') {
        pollCount += 1;
        return { diagnostics: {} } as T;
      }

      throw new Error(`unexpected command ${command}`);
    };

    try {
      scheduleLanguageIntelligenceRefresh({
        invoke,
        workspacePath,
        paths: ['src/Clean.ts'],
        force: true,
      });

      await vi.runAllTimersAsync();

      expect(pollCount).toBe(LANGUAGE_INTELLIGENCE_DIAGNOSTIC_POLL_DELAYS_MS.length);
      expect(getCachedLanguageIntelligence(workspacePath, 'src/Clean.ts')).toMatchObject({
        relativePath: 'src/Clean.ts',
        status: 'ready',
        diagnostics: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling as soon as diagnostics appear', async () => {
    vi.useFakeTimers();
    const workspacePath = '/tmp/codepapr-lsp-workspace';
    let pollCount = 0;
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
            workspaceDiagnostics: [],
            server: {
              languageId: 'typescript',
              serverFamily: 'typescript',
              running: true,
              command: 'typescript-language-server --stdio',
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

      if (command === 'lsp_get_diagnostics') {
        pollCount += 1;
        return {
          diagnostics: {
            [`file://${workspacePath}/src/Dirty.ts`]: {
              diagnostics: [
                {
                  severity: 1,
                  message: 'Cannot find name x',
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 1 },
                  },
                },
              ],
            },
          },
        } as T;
      }

      throw new Error(`unexpected command ${command}`);
    };

    try {
      scheduleLanguageIntelligenceRefresh({
        invoke,
        workspacePath,
        paths: ['src/Dirty.ts'],
        force: true,
      });

      await vi.runAllTimersAsync();

      expect(pollCount).toBe(1);
      expect(getCachedLanguageIntelligence(workspacePath, 'src/Dirty.ts')).toMatchObject({
        relativePath: 'src/Dirty.ts',
        status: 'ready',
        diagnostics: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});