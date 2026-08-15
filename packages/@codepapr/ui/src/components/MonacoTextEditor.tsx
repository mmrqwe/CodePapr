import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import 'monaco-editor/esm/vs/language/css/monaco.contribution';
import 'monaco-editor/esm/vs/language/html/monaco.contribution';
import 'monaco-editor/esm/vs/language/json/monaco.contribution';
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution';
import 'monaco-editor/esm/vs/basic-languages/bat/bat.contribution';
import 'monaco-editor/esm/vs/basic-languages/bicep/bicep.contribution';
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution';
import 'monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution';
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution';
import 'monaco-editor/esm/vs/basic-languages/dart/dart.contribution';
import 'monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution';
import 'monaco-editor/esm/vs/basic-languages/fsharp/fsharp.contribution';
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution';
import 'monaco-editor/esm/vs/basic-languages/graphql/graphql.contribution';
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution';
import 'monaco-editor/esm/vs/basic-languages/ini/ini.contribution';
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution';
import 'monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution';
import 'monaco-editor/esm/vs/basic-languages/less/less.contribution';
import 'monaco-editor/esm/vs/basic-languages/lua/lua.contribution';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
import 'monaco-editor/esm/vs/basic-languages/mysql/mysql.contribution';
import 'monaco-editor/esm/vs/basic-languages/objective-c/objective-c.contribution';
import 'monaco-editor/esm/vs/basic-languages/perl/perl.contribution';
import 'monaco-editor/esm/vs/basic-languages/pgsql/pgsql.contribution';
import 'monaco-editor/esm/vs/basic-languages/php/php.contribution';
import 'monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution';
import 'monaco-editor/esm/vs/basic-languages/protobuf/protobuf.contribution';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution';
import 'monaco-editor/esm/vs/basic-languages/r/r.contribution';
import 'monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution';
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution';
import 'monaco-editor/esm/vs/basic-languages/scala/scala.contribution';
import 'monaco-editor/esm/vs/basic-languages/scss/scss.contribution';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution';
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution';
import 'monaco-editor/esm/vs/basic-languages/swift/swift.contribution';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution';
import 'monaco-editor/esm/vs/basic-languages/vb/vb.contribution';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution';
import 'monaco-editor/min/vs/editor/editor.main.css';
import {
  type MonacoExternalMarker,
  type MonacoEditorPosition,
  type MonacoEditorNavigationLocation,
  type MonacoLspHoverResult,
  markerSeverityToValue,
} from '@codepapr/editor';
import { filterDeclaredModuleResolutionDiagnostics } from '../utils/editorWorkspaceModules';
import {
  summarizeEditorDiagnostics,
  type EditorDiagnosticsSummary,
} from '../utils/editorDiagnostics';

type MonacoWorkerEnvironment = {
  getWorker: (_moduleId: string, label: string) => Worker;
};

const globalHost = self as typeof self & { MonacoEnvironment?: MonacoWorkerEnvironment };
globalHost.MonacoEnvironment ??= {
  getWorker: (_moduleId, label) => {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

let didConfigureMonaco = false;
const EMPTY_DECLARED_MODULE_NAMES: readonly string[] = [];
const EMPTY_EXTERNAL_MARKERS: readonly MonacoExternalMarker[] = [];
const EMPTY_EXCLUDED_MARKER_OWNERS: readonly string[] = [];

function repaintMonacoEditor(
  editor:
    | monaco.editor.IStandaloneCodeEditor
    | monaco.editor.IStandaloneDiffEditor
    | null
): void {
  if (!editor) {
    return;
  }

  editor.layout();
  (editor as unknown as { render?: (forceRedraw?: boolean) => void }).render?.(true);
}

export function scheduleSecondPassRelayout(callback: () => void): void {
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(callback);
    return;
  }

  globalThis.setTimeout(callback, 0);
}

export function detectMonacoThemeName(): 'vs' | 'vs-dark' {
  if (typeof document === 'undefined') return 'vs-dark';
  return document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs';
}

let monacoThemeObserver: MutationObserver | null = null;

function ensureMonacoThemeAutoSync(): void {
  if (monacoThemeObserver || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  monacoThemeObserver = new MutationObserver(() => {
    monaco.editor.setTheme(detectMonacoThemeName());
  });
  monacoThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
}

export function configureMonacoLanguageServices(): void {
  monaco.editor.setTheme(detectMonacoThemeName());
  ensureMonacoThemeAutoSync();
  if (didConfigureMonaco) return;
  didConfigureMonaco = true;

  const compilerOptions: monaco.languages.typescript.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    noEmit: true,
    strict: true,
    target: monaco.languages.typescript.ScriptTarget.ESNext,
  };

  monaco.languages.typescript.typescriptDefaults.setCompilerOptions(compilerOptions);
  monaco.languages.typescript.javascriptDefaults.setCompilerOptions(compilerOptions);
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: false,
  });
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: false,
  });
  monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);
  monaco.languages.typescript.javascriptDefaults.setEagerModelSync(true);

  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    allowComments: true,
    enableSchemaRequest: true,
    validate: true,
    schemas: [],
  });
}

interface MonacoTextEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language?: string;
  minHeight?: number;
  readOnly?: boolean;
  ariaLabel?: string;
  modelPath?: string;
  revealLineNumber?: number;
  revealColumn?: number;
  onDiagnosticsChange?: (summary: EditorDiagnosticsSummary) => void;
  declaredModuleNames?: readonly string[];
  externalMarkers?: readonly MonacoExternalMarker[];
  externalMarkerOwner?: string;
  excludedDiagnosticMarkerOwners?: readonly string[];
  lspHoverProvider?: (position: MonacoEditorPosition) => Promise<MonacoLspHoverResult | null>;
  lspDefinitionProvider?: (
    position: MonacoEditorPosition
  ) => Promise<readonly MonacoEditorNavigationLocation[]>;
  onOpenLocation?: (location: MonacoEditorNavigationLocation) => void;
}

function toMonacoMarker(marker: MonacoExternalMarker): monaco.editor.IMarkerData {
  return {
    severity: markerSeverityToValue(marker.severity) as monaco.MarkerSeverity,
    message: marker.message,
    startLineNumber: marker.startLineNumber,
    startColumn: marker.startColumn,
    endLineNumber: marker.endLineNumber,
    endColumn: marker.endColumn,
    source: marker.source,
  };
}

function toModelUri(path: string | undefined): monaco.Uri | undefined {
  const trimmed = path?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.replace(/^\/+/, '');
  return monaco.Uri.parse(`file:///workspace/${normalized}`);
}

function summarizeModelDiagnostics(
  model: monaco.editor.ITextModel,
  declaredModuleNames: readonly string[],
  excludedMarkerOwners: readonly string[]
): EditorDiagnosticsSummary {
  const excludedOwners = new Set(excludedMarkerOwners);
  const visibleMarkers = monaco
    .editor
    .getModelMarkers({ resource: model.uri })
    .filter((marker) => !excludedOwners.has((marker as { owner?: string }).owner ?? ''));

  return summarizeEditorDiagnostics(
    filterDeclaredModuleResolutionDiagnostics(visibleMarkers, declaredModuleNames)
  );
}

export function MonacoTextEditor({
  value,
  onChange,
  language = 'markdown',
  minHeight = 220,
  readOnly = false,
  ariaLabel = '编辑器',
  modelPath,
  revealLineNumber,
  revealColumn,
  onDiagnosticsChange,
  declaredModuleNames = EMPTY_DECLARED_MODULE_NAMES,
  externalMarkers = EMPTY_EXTERNAL_MARKERS,
  externalMarkerOwner = 'codepapr',
  excludedDiagnosticMarkerOwners = EMPTY_EXCLUDED_MARKER_OWNERS,
  lspHoverProvider,
  lspDefinitionProvider,
  onOpenLocation,
}: MonacoTextEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const onChangeRef = useRef(onChange);
  const onDiagnosticsChangeRef = useRef(onDiagnosticsChange);
  const declaredModuleNamesRef = useRef(declaredModuleNames);
  const excludedDiagnosticMarkerOwnersRef = useRef(excludedDiagnosticMarkerOwners);
  const lspHoverProviderRef = useRef(lspHoverProvider);
  const lspDefinitionProviderRef = useRef(lspDefinitionProvider);
  const onOpenLocationRef = useRef(onOpenLocation);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onDiagnosticsChangeRef.current = onDiagnosticsChange;
  }, [onDiagnosticsChange]);

  useEffect(() => {
    declaredModuleNamesRef.current = declaredModuleNames;
  }, [declaredModuleNames]);

  useEffect(() => {
    excludedDiagnosticMarkerOwnersRef.current = excludedDiagnosticMarkerOwners;
  }, [excludedDiagnosticMarkerOwners]);

  useEffect(() => {
    lspHoverProviderRef.current = lspHoverProvider;
  }, [lspHoverProvider]);

  useEffect(() => {
    lspDefinitionProviderRef.current = lspDefinitionProvider;
  }, [lspDefinitionProvider]);

  useEffect(() => {
    onOpenLocationRef.current = onOpenLocation;
  }, [onOpenLocation]);

  useEffect(() => {
    const model = modelRef.current;
    if (!model || !onDiagnosticsChange) {
      return;
    }

    onDiagnosticsChange(summarizeModelDiagnostics(model, declaredModuleNames, excludedDiagnosticMarkerOwners));
  }, [declaredModuleNames, excludedDiagnosticMarkerOwners, onDiagnosticsChange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    configureMonacoLanguageServices();

    const model = monaco.editor.createModel(value, language, toModelUri(modelPath));
    modelRef.current = model;

    const editor = monaco.editor.create(
      container,
      {
        model,
        theme: detectMonacoThemeName(),
        automaticLayout: false,
        minimap: { enabled: false },
        bracketPairColorization: { enabled: true },
        codeLens: !readOnly,
        readOnly,
        domReadOnly: readOnly,
        fontSize: 13,
        folding: true,
        formatOnPaste: true,
        formatOnType: true,
        glyphMargin: true,
        lineHeight: 20,
        links: true,
        matchBrackets: 'always',
        occurrencesHighlight: 'singleFile',
        quickSuggestions: true,
        scrollBeyondLastLine: false,
        showUnused: true,
        suggestOnTriggerCharacters: true,
        wordWrap: 'on',
        wrappingIndent: 'same',
        tabSize: 2,
        padding: { top: 12, bottom: 12 },
        guides: { bracketPairs: true, indentation: true },
        lineNumbersMinChars: 3,
        renderLineHighlight: 'line',
        overviewRulerBorder: false,
        hideCursorInOverviewRuler: true,
        accessibilitySupport: 'auto',
        ariaLabel,
      },
      onOpenLocation
        ? ({
            codeEditorService: {
              openCodeEditor: async (input: {
                resource?: { toString: () => string };
                options?: {
                  selection?: {
                    startLineNumber?: number;
                    startColumn?: number;
                    endLineNumber?: number;
                    endColumn?: number;
                  };
                };
              }) => {
                const resource = input.resource?.toString();
                if (!resource) {
                  return null;
                }

                const selection = input.options?.selection;
                onOpenLocationRef.current?.({
                  uri: resource,
                  lineNumber: selection?.startLineNumber ?? 1,
                  column: selection?.startColumn ?? 1,
                  endLineNumber: selection?.endLineNumber,
                  endColumn: selection?.endColumn,
                });
                return null;
              },
            },
          } as monaco.editor.IEditorOverrideServices)
        : undefined
    );

    editorRef.current = editor;
    const contentSubscription = editor.onDidChangeModelContent(() => {
      onChangeRef.current?.(editor.getValue());
    });
    const emitDiagnostics = () => {
      if (!onDiagnosticsChangeRef.current) {
        return;
      }

      onDiagnosticsChangeRef.current(
        summarizeModelDiagnostics(
          model,
          declaredModuleNamesRef.current,
          excludedDiagnosticMarkerOwnersRef.current
        )
      );
    };
    const markerSubscription = monaco.editor.onDidChangeMarkers((resources) => {
      if (resources.some((resource) => resource.toString() === model.uri.toString())) {
        emitDiagnostics();
      }
    });
    const relayoutEditor = () => repaintMonacoEditor(editorRef.current);
    const resizeObserver = new ResizeObserver(relayoutEditor);
    resizeObserver.observe(container);
    window.addEventListener('resize', relayoutEditor);
    emitDiagnostics();

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', relayoutEditor);
      contentSubscription.dispose();
      markerSubscription.dispose();
      editor.dispose();
      model.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
  }, [ariaLabel, modelPath, readOnly]);

  useEffect(() => {
    const model = modelRef.current;
    if (model && model.getValue() !== value) {
      model.setValue(value);
    }
  }, [value]);

  useEffect(() => {
    const model = modelRef.current;
    if (model) {
      monaco.editor.setModelLanguage(model, language);
    }
  }, [language]);

  useEffect(() => {
    const model = modelRef.current;
    if (!model) {
      return;
    }
    monaco.editor.setModelMarkers(model, externalMarkerOwner, externalMarkers.map(toMonacoMarker));
  }, [externalMarkerOwner, externalMarkers]);

  useEffect(() => {
    const model = modelRef.current;
    if (!model) {
      return;
    }

    const modelUri = model.uri.toString();
    const registrations: monaco.IDisposable[] = [];

    if (lspHoverProvider) {
      registrations.push(
        monaco.languages.registerHoverProvider(language, {
          provideHover: async (currentModel, position) => {
            if (currentModel.uri.toString() !== modelUri) {
              return null;
            }

            const result = await lspHoverProviderRef.current?.({
              lineNumber: position.lineNumber,
              column: position.column,
            });
            if (!result || result.contents.length === 0) {
              return null;
            }

            return {
              contents: result.contents.map((value) => ({ value })),
              range: result.range
                ? new monaco.Range(
                    result.range.startLineNumber,
                    result.range.startColumn,
                    result.range.endLineNumber,
                    result.range.endColumn
                  )
                : undefined,
            };
          },
        })
      );
    }

    if (lspDefinitionProvider) {
      registrations.push(
        monaco.languages.registerDefinitionProvider(language, {
          provideDefinition: async (currentModel, position) => {
            if (currentModel.uri.toString() !== modelUri) {
              return [];
            }

            const result = await lspDefinitionProviderRef.current?.({
              lineNumber: position.lineNumber,
              column: position.column,
            });
            if (!result || result.length === 0) {
              return [];
            }

            return result.map((location) => ({
              uri: monaco.Uri.parse(location.uri),
              range: new monaco.Range(
                location.lineNumber,
                location.column,
                location.endLineNumber ?? location.lineNumber,
                location.endColumn ?? location.column
              ),
            }));
          },
        })
      );
    }

    return () => {
      for (const registration of registrations) {
        registration.dispose();
      }
    };
  }, [language, lspDefinitionProvider, lspHoverProvider, modelPath]);

  useEffect(() => {
    const editor = editorRef.current;
    const model = modelRef.current;
    if (!editor || !model || !revealLineNumber) {
      return;
    }

    const safeLine = Math.min(Math.max(Math.floor(revealLineNumber), 1), model.getLineCount());
    const safeColumn = Math.min(
      Math.max(Math.floor(revealColumn ?? 1), 1),
      model.getLineMaxColumn(safeLine)
    );
    const position = {
      lineNumber: safeLine,
      column: safeColumn,
    };

    editor.setPosition(position);
    editor.setSelection(new monaco.Range(safeLine, safeColumn, safeLine, safeColumn));
    editor.revealPositionInCenter(position, monaco.editor.ScrollType.Smooth);
    editor.focus();
  }, [modelPath, revealColumn, revealLineNumber, value]);

  return (
    <div
      ref={containerRef}
      className="h-full min-h-0 overflow-hidden rounded-xl border border-line bg-base transition-colors focus-within:border-accent-soft"
      style={{ minHeight }}
    />
  );
}
