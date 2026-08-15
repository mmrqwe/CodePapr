import { memo, useEffect, useState, type ReactNode } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { normalizeMarkdownCodeLanguage } from '../utils/markdownCodeLanguage';
import { configureMonacoLanguageServices } from './MonacoTextEditor';
import { applyActiveMonacoTheme } from '../theme/monacoThemes';
import { useThemeStore } from '../store/themeStore';

function decodeWorkspaceFileHref(href: string | undefined): string | null {
  if (!href || !href.startsWith('codepapr-file:')) {
    return null;
  }

  try {
    return decodeURIComponent(href.slice('codepapr-file:'.length));
  } catch {
    return href.slice('codepapr-file:'.length);
  }
}

function CodeBlock({
  code,
  language,
  copyLabel,
  skipColorize,
}: {
  code: string;
  language: string;
  copyLabel: string;
  skipColorize?: boolean;
}) {
  const normalizedLanguage = normalizeMarkdownCodeLanguage(language);
  const usesMonacoColorize = !skipColorize && normalizedLanguage !== 'plaintext';
  const [highlightedHtml, setHighlightedHtml] = useState('');
  const resolvedThemeId = useThemeStore((state) => state.resolvedThemeId);
  const accent = useThemeStore((state) => state.accent);

  useEffect(() => {
    if (!usesMonacoColorize) {
      setHighlightedHtml('');
      return;
    }

    let cancelled = false;
    configureMonacoLanguageServices();
    // 按当前应用主题（含强调色）生成 monaco 主题，colorize 输出的内联
    // token 颜色与主题一致，无需任何 CSS 重映射。
    applyActiveMonacoTheme();

    void monaco.editor
      .colorize(code, normalizedLanguage, {
        tabSize: 2,
      })
      .then((html) => {
        if (!cancelled) {
          setHighlightedHtml(html);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHighlightedHtml('');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [code, normalizedLanguage, usesMonacoColorize, resolvedThemeId, accent]);

  const copy = async () => {
    await navigator.clipboard.writeText(code);
  };

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-line bg-base">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
        <span className="text-[11px] text-fg-muted">{normalizedLanguage || 'code'}</span>
        <button
          type="button"
          onClick={copy}
          className="text-[11px] text-fg-muted transition-colors hover:text-fg"
        >
          {copyLabel}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2 text-xs leading-relaxed text-fg">
        {highlightedHtml ? (
          <code
            className="block text-fg"
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        ) : (
          <code className="block whitespace-pre text-fg">{code}</code>
        )}
      </pre>
    </div>
  );
}

function preprocessFileLinks(content: string): string {
  return content.replace(
    /`([\w./-]+\.\w{1,8}(?::\d+)?)`/g,
    (match, path) => {
      const cleanedPath = (path as string).replace(/:\d+$/, '');
      // Require at least one directory separator to avoid matching
      // single words with dots (e.g. `true` in a backtick-delimited code span).
      if (!/\//.test(cleanedPath)) {
        return match;
      }
      return `[\`${path}\`](codepapr-file:${encodeURIComponent(cleanedPath)})`;
    }
  );
}

interface MarkdownRendererProps {
  content: string;
  copyLabel: string;
  onOpenWorkspacePath?: (path: string) => void;
  className?: string;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  copyLabel,
  onOpenWorkspacePath,
  className,
}: MarkdownRendererProps) {
  const markdownComponents: Components = {
    p: ({ children }) => <p className="my-2 whitespace-pre-wrap break-words">{children}</p>,
    ul: ({ children }) => <ul className="my-2 list-disc pl-5 space-y-1">{children}</ul>,
    ol: ({ children }) => <ol className="my-2 list-decimal pl-5 space-y-1">{children}</ol>,
    li: ({ children }) => <li className="break-words">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className="my-3 border-l-2 border-slate-600/70 pl-3 text-fg-muted">
        {children}
      </blockquote>
    ),
    a: ({ href, children }) => {
      const workspacePath = decodeWorkspaceFileHref(href);

      if (workspacePath && onOpenWorkspacePath) {
        return (
          <button
            type="button"
            onClick={() => onOpenWorkspacePath(workspacePath)}
            className="text-left text-info underline decoration-sky-500/40 underline-offset-2 hover:text-info"
          >
            {children}
          </button>
        );
      }

      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="text-info underline decoration-sky-500/40 underline-offset-2 hover:text-info"
        >
          {children}
        </a>
      );
    },
    h1: ({ children }) => <h1 className="mt-4 mb-2 text-lg font-semibold text-fg">{children}</h1>,
    h2: ({ children }) => <h2 className="mt-4 mb-2 text-base font-semibold text-fg">{children}</h2>,
    h3: ({ children }) => <h3 className="mt-3 mb-1.5 text-sm font-semibold text-fg">{children}</h3>,
    h4: ({ children }) => <h4 className="mt-3 mb-1 text-sm font-semibold text-fg">{children}</h4>,
    h5: ({ children }) => <h5 className="mt-2 mb-1 text-sm font-semibold text-fg">{children}</h5>,
    h6: ({ children }) => <h6 className="mt-2 mb-1 text-xs font-semibold text-fg-soft">{children}</h6>,
    hr: () => <hr className="my-3 border-line" />,
    table: ({ children }) => (
      <div className="my-3 overflow-x-auto rounded-xl border border-line">
        <table className="min-w-full border-collapse text-xs">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-base text-fg-soft">{children}</thead>,
    tbody: ({ children }) => <tbody>{children}</tbody>,
    tr: ({ children }) => <tr className="border-t border-line">{children}</tr>,
    th: ({ children }) => <th className="px-3 py-2 text-left font-semibold">{children}</th>,
    td: ({ children }) => <td className="px-3 py-2 align-top text-fg-soft">{children}</td>,
    pre: ({ children }) => <>{children}</>,
    code: ({ className: codeClassName, children }) => {
      const text = String(children as ReactNode).replace(/\n$/, '');
      const language = /language-([\w.+-]+)/.exec(codeClassName || '')?.[1] ?? '';
      const isInline = !codeClassName && !text.includes('\n');

      if (isInline) {
        return (
          <code className="rounded bg-base px-1.5 py-0.5 text-[12px] text-code-fg">
            {text}
          </code>
        );
      }

      return <CodeBlock code={text} language={language} copyLabel={copyLabel} />;
    },
    em: ({ children }) => <em className="italic text-fg-muted">{children}</em>,
    strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
    img: ({ src, alt }) => (
      <img
        src={src}
        alt={alt}
        className="my-2 max-w-full rounded-lg border border-line"
        loading="lazy"
      />
    ),
    input: ({ checked, type, ...rest }) => {
      if (type === 'checkbox') {
        return (
          <input
            type="checkbox"
            checked={checked}
            readOnly
            className="mr-1.5 align-middle accent-accent"
            {...rest}
          />
        );
      }
      return <input type={type} {...rest} />;
    },
  };

  return (
    <div className={`markdown-body text-sm leading-relaxed${className ? ` ${className}` : ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={markdownComponents}>
        {preprocessFileLinks(content)}
      </ReactMarkdown>
    </div>
  );
});
