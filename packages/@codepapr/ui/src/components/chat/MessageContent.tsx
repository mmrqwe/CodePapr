import { MarkdownRenderer } from '../MarkdownRenderer';
import { getTranslation } from '../../utils/i18n';
import {
  getStreamingPreviewContent,
  MAX_STREAMING_MESSAGE_CHARS,
  type Lang,
} from './utils';

export function MessageContent({
  content,
  lang,
  onOpenWorkspacePath,
  isStreaming,
}: {
  content: string;
  lang: Lang;
  onOpenWorkspacePath?: (path: string) => void;
  isStreaming?: boolean;
}) {
  if (isStreaming) {
    const visibleContent = getStreamingPreviewContent(content, MAX_STREAMING_MESSAGE_CHARS);

    return (
      <p className="text-sm leading-relaxed whitespace-pre-wrap break-words text-slate-200">
        {visibleContent}
      </p>
    );
  }

  const t = getTranslation(lang);

  return (
    <MarkdownRenderer
      content={content}
      copyLabel={t.copy}
      onOpenWorkspacePath={onOpenWorkspacePath}
    />
  );
}
