import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import {
  configureMonacoLanguageServices,
  detectMonacoThemeName,
} from './MonacoTextEditor';

interface MonacoDiffEditorProps {
  originalValue: string;
  modifiedValue: string;
  language?: string;
  minHeight?: number;
  ariaLabel?: string;
  /** Called once after the diff editor is created, exposing the raw
   *  monaco editor instance for glyph-margin decorations, view zones, etc. */
  onReady?: (editor: monaco.editor.IStandaloneDiffEditor) => void;
}

export function MonacoDiffEditor({
  originalValue,
  modifiedValue,
  language = 'markdown',
  minHeight = 220,
  ariaLabel = '差异编辑器',
  onReady,
}: MonacoDiffEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const originalModelRef = useRef<monaco.editor.ITextModel | null>(null);
  const modifiedModelRef = useRef<monaco.editor.ITextModel | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    configureMonacoLanguageServices();

    const originalModel = monaco.editor.createModel(originalValue, language);
    const modifiedModel = monaco.editor.createModel(modifiedValue, language);
    originalModelRef.current = originalModel;
    modifiedModelRef.current = modifiedModel;

    const editor = monaco.editor.createDiffEditor(container, {
      theme: detectMonacoThemeName(),
      automaticLayout: false,
      diffWordWrap: 'on',
      enableSplitViewResizing: true,
      hideUnchangedRegions: { enabled: false },
      ignoreTrimWhitespace: false,
      minimap: { enabled: false },
      originalEditable: false,
      readOnly: true,
      renderIndicators: true,
      renderOverviewRuler: true,
      scrollBeyondLastLine: false,
      useInlineViewWhenSpaceIsLimited: true,
      wordWrap: 'on',
      glyphMargin: true,
      accessibilitySupport: 'auto',
      ariaLabel,
    });

    editor.setModel({
      original: originalModel,
      modified: modifiedModel,
    });

    editorRef.current = editor;
    if (onReady) {
      onReady(editor);
    }
    const relayoutEditor = () => {
      editor.layout();
      (editor as unknown as { render?: (forceRedraw?: boolean) => void }).render?.(true);
    };
    const resizeObserver = new ResizeObserver(relayoutEditor);
    resizeObserver.observe(container);
    window.addEventListener('resize', relayoutEditor);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', relayoutEditor);
      editor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
      editorRef.current = null;
      originalModelRef.current = null;
      modifiedModelRef.current = null;
    };
  }, [ariaLabel, language]);

  useEffect(() => {
    const originalModel = originalModelRef.current;
    const modifiedModel = modifiedModelRef.current;
    if (originalModel && originalModel.getValue() !== originalValue) {
      originalModel.setValue(originalValue);
    }
    if (modifiedModel && modifiedModel.getValue() !== modifiedValue) {
      modifiedModel.setValue(modifiedValue);
    }
  }, [modifiedValue, originalValue]);

  useEffect(() => {
    const originalModel = originalModelRef.current;
    const modifiedModel = modifiedModelRef.current;
    if (originalModel) {
      monaco.editor.setModelLanguage(originalModel, language);
    }
    if (modifiedModel) {
      monaco.editor.setModelLanguage(modifiedModel, language);
    }
  }, [language]);

  return (
    <div
      ref={containerRef}
      className="h-full min-h-0 overflow-hidden rounded-xl border border-line bg-base transition-colors focus-within:border-accent-soft"
      style={{ minHeight }}
    />
  );
}
