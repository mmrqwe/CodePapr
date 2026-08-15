import { useState } from 'react';
import { getTranslation } from '../../utils/i18n';
import {
  buildTailExecutionProcessGroup,
  formatProcessDuration,
  getProcessGroupCopy,
  type ExecutionProcessGroup,
  type Lang,
} from './utils';
import { MessageBubble } from './MessageBubble';

export { buildTailExecutionProcessGroup, type ExecutionProcessGroup };

export function ExecutionProcessPanel({
  group,
  lang,
  onOpenWorkspacePath,
}: {
  group: ExecutionProcessGroup;
  lang: Lang;
  onOpenWorkspacePath?: (path: string) => void;
}) {
  const t = getTranslation(lang);
  const copy = getProcessGroupCopy(lang);
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div
      className="mb-4 overflow-hidden rounded-2xl border border-line bg-base/88"
      data-process-group-state={isOpen ? 'open' : 'closed'}
    >
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="min-w-0">
          <div className="text-sm font-semibold text-fg">{copy.title}</div>
          <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-fg-muted">
            <span>{copy.steps(group.messages.length)}</span>
            <span>{copy.duration(formatProcessDuration(group.durationMs, lang))}</span>
          </div>
        </div>
        <span className="shrink-0 text-[11px] text-fg-muted">
          {isOpen ? t.collapse : t.expand}
        </span>
      </button>
      {isOpen && (
        <div className="max-h-[52vh] overflow-y-auto overscroll-contain scrollbar-thin scrollbar-stable border-t border-line px-4 py-3">
          {group.messages.map((message) => (
            <MessageBubble
              key={message.id}
              msg={message}
              lang={lang}
              onOpenWorkspacePath={onOpenWorkspacePath}
            />
          ))}
        </div>
      )}
    </div>
  );
}
