// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as monacoApi from 'monaco-editor/esm/vs/editor/editor.api';

const monacoMocks = vi.hoisted(() => {
  const models: Array<{
    value: string;
    uri: { toString: () => string };
    getValue: () => string;
    setValue: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    getLineCount: () => number;
    getLineMaxColumn: () => number;
  }> = [];

  const createModelMock = vi.fn((value: string, _language: string, uri?: { toString: () => string }) => {
    const model = {
      value,
      uri: uri ?? { toString: () => 'inmemory://model' },
      getValue: () => model.value,
      setValue: vi.fn((nextValue: string) => {
        model.value = nextValue;
      }),
      dispose: vi.fn(),
      getLineCount: () => 1,
      getLineMaxColumn: () => 1,
    };
    models.push(model);
    return model;
  });

  const createEditorMock = vi.fn(
    (
      _container: HTMLElement,
      options: { model: { getValue: () => string } },
      _overrideServices?: unknown
    ) => ({
      getValue: () => options.model.getValue(),
      onDidChangeModelContent: vi.fn(() => ({ dispose: vi.fn() })),
      layout: vi.fn(),
      render: vi.fn(),
      dispose: vi.fn(),
      setPosition: vi.fn(),
      setSelection: vi.fn(),
      revealPositionInCenter: vi.fn(),
      focus: vi.fn(),
    })
  );

  return {
    models,
    createModelMock,
    createEditorMock,
    setModelLanguageMock: vi.fn(),
    setModelMarkersMock: vi.fn(),
    registerHoverProviderMock: vi.fn(() => ({ dispose: vi.fn() })),
    registerDefinitionProviderMock: vi.fn(() => ({ dispose: vi.fn() })),
  };
});

vi.mock('monaco-editor/esm/vs/editor/editor.api', () => ({
  editor: {
    ScrollType: { Smooth: 1 },
    createModel: monacoMocks.createModelMock,
    create: monacoMocks.createEditorMock,
    setTheme: vi.fn(),
    onDidChangeMarkers: vi.fn(() => ({ dispose: vi.fn() })),
    getModelMarkers: vi.fn(() => []),
    setModelLanguage: monacoMocks.setModelLanguageMock,
    setModelMarkers: monacoMocks.setModelMarkersMock,
  },
  languages: {
    register: vi.fn(),
    registerTokensProviderFactory: vi.fn(),
    onLanguageEncountered: vi.fn(),
    setLanguageConfiguration: vi.fn(),
    registerHoverProvider: monacoMocks.registerHoverProviderMock,
    registerDefinitionProvider: monacoMocks.registerDefinitionProviderMock,
    typescript: {
      JsxEmit: { ReactJSX: 1 },
      ModuleKind: { ESNext: 99 },
      ModuleResolutionKind: { NodeJs: 2 },
      ScriptTarget: { ESNext: 99 },
      typescriptDefaults: {
        setCompilerOptions: vi.fn(),
        setDiagnosticsOptions: vi.fn(),
        setEagerModelSync: vi.fn(),
      },
      javascriptDefaults: {
        setCompilerOptions: vi.fn(),
        setDiagnosticsOptions: vi.fn(),
        setEagerModelSync: vi.fn(),
      },
    },
    json: {
      jsonDefaults: {
        setDiagnosticsOptions: vi.fn(),
      },
    },
  },
  MarkerSeverity: {
    Error: 8,
    Warning: 4,
    Info: 2,
    Hint: 1,
  },
  Uri: {
    parse: vi.fn((value: string) => ({ toString: () => value })),
  },
  Range: class MockRange {
    constructor(
      readonly startLineNumber: number,
      readonly startColumn: number,
      readonly endLineNumber: number,
      readonly endColumn: number
    ) {}
  },
}));

vi.mock('monaco-editor/esm/vs/editor/editor.worker?worker', () => ({ default: class MockWorker {} }));
vi.mock('monaco-editor/esm/vs/language/css/css.worker?worker', () => ({ default: class MockWorker {} }));
vi.mock('monaco-editor/esm/vs/language/html/html.worker?worker', () => ({ default: class MockWorker {} }));
vi.mock('monaco-editor/esm/vs/language/json/json.worker?worker', () => ({ default: class MockWorker {} }));
vi.mock('monaco-editor/esm/vs/language/typescript/ts.worker?worker', () => ({ default: class MockWorker {} }));

vi.mock('monaco-editor/esm/vs/language/css/monaco.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/language/html/monaco.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/language/json/monaco.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/language/typescript/monaco.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/bat/bat.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/bicep/bicep.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/css/css.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/dart/dart.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/fsharp/fsharp.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/go/go.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/graphql/graphql.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/ini/ini.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/java/java.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/less/less.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/lua/lua.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/mysql/mysql.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/objective-c/objective-c.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/perl/perl.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/pgsql/pgsql.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/php/php.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/protobuf/protobuf.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/python/python.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/r/r.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/rust/rust.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/scala/scala.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/scss/scss.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/shell/shell.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/sql/sql.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/swift/swift.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/vb/vb.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/xml/xml.contribution', () => ({}));
vi.mock('monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution', () => ({}));
vi.mock('monaco-editor/min/vs/editor/editor.main.css', () => ({}));

import { MonacoTextEditor } from './MonacoTextEditor';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

class MockResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
}

describe('MonacoTextEditor', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    monacoMocks.models.length = 0;
    monacoMocks.createModelMock.mockClear();
    monacoMocks.createEditorMock.mockClear();
    monacoMocks.setModelLanguageMock.mockClear();
    monacoMocks.setModelMarkersMock.mockClear();
    monacoMocks.registerHoverProviderMock.mockClear();
    monacoMocks.registerDefinitionProviderMock.mockClear();
    vi.mocked(monacoApi.editor.getModelMarkers).mockReturnValue([]);
    vi.stubGlobal('ResizeObserver', MockResizeObserver);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('keeps the same Monaco editor instance across controlled value rerenders', async () => {
    await act(async () => {
      root.render(
        <MonacoTextEditor
          value="A"
          onChange={() => undefined}
          language="markdown"
          modelPath="AGENTS.md"
        />
      );
    });

    expect(monacoMocks.createModelMock).toHaveBeenCalledTimes(1);
    expect(monacoMocks.createEditorMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <MonacoTextEditor
          value="AB"
          onChange={() => undefined}
          language="markdown"
          modelPath="AGENTS.md"
        />
      );
    });

    expect(monacoMocks.createModelMock).toHaveBeenCalledTimes(1);
    expect(monacoMocks.createEditorMock).toHaveBeenCalledTimes(1);
    expect(monacoMocks.models[0]?.setValue).toHaveBeenCalledWith('AB');
  });

  it('ignores external marker owners when reporting local diagnostics', async () => {
    const onDiagnosticsChange = vi.fn();
    vi.mocked(monacoApi.editor.getModelMarkers).mockReturnValue([
      {
        owner: 'codepapr-lsp',
        severity: 8,
        message: 'LSP error',
        startLineNumber: 2,
        startColumn: 4,
      },
      {
        owner: 'typescript',
        severity: 4,
        message: 'Local warning',
        startLineNumber: 3,
        startColumn: 2,
      },
    ] as never);

    await act(async () => {
      root.render(
        <MonacoTextEditor
          value="const x = 1;"
          language="typescript"
          modelPath="src/example.ts"
          onDiagnosticsChange={onDiagnosticsChange}
          excludedDiagnosticMarkerOwners={["codepapr-lsp"]}
        />
      );
    });

    const lastSummary = onDiagnosticsChange.mock.calls.at(-1)?.[0];
    expect(lastSummary).toMatchObject({
      total: 1,
      errors: 0,
      warnings: 1,
    });
    expect(lastSummary?.items).toEqual([
      {
        severity: 'warning',
        message: 'Local warning',
        startLineNumber: 3,
        startColumn: 2,
      },
    ]);
  });

  it('routes Monaco openCodeEditor requests through the onOpenLocation callback', async () => {
    const onOpenLocation = vi.fn();

    await act(async () => {
      root.render(
        <MonacoTextEditor
          value="const value = 1;"
          language="typescript"
          modelPath="src/example.ts"
          onOpenLocation={onOpenLocation}
          lspDefinitionProvider={async () => [
            {
              uri: 'file:///workspace/src/dep.ts',
              lineNumber: 5,
              column: 9,
              endLineNumber: 5,
              endColumn: 14,
            },
          ]}
        />
      );
    });

    expect(monacoMocks.registerDefinitionProviderMock).toHaveBeenCalledWith(
      'typescript',
      expect.any(Object)
    );

    const overrideServices = monacoMocks.createEditorMock.mock.calls[0]?.[2] as {
      codeEditorService?: {
        openCodeEditor?: (input: {
          resource?: { toString: () => string };
          options?: {
            selection?: {
              startLineNumber?: number;
              startColumn?: number;
              endLineNumber?: number;
              endColumn?: number;
            };
          };
        }) => Promise<null>;
      };
    };

    await overrideServices.codeEditorService?.openCodeEditor?.({
      resource: { toString: () => 'file:///workspace/src/dep.ts' },
      options: {
        selection: {
          startLineNumber: 5,
          startColumn: 9,
          endLineNumber: 5,
          endColumn: 14,
        },
      },
    });

    expect(onOpenLocation).toHaveBeenCalledWith({
      uri: 'file:///workspace/src/dep.ts',
      lineNumber: 5,
      column: 9,
      endLineNumber: 5,
      endColumn: 14,
    });
  });

});
