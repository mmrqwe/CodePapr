import { forwardRef, memo, useEffect, type ClipboardEvent, type KeyboardEvent } from 'react';

interface ChatInputTextareaProps {
  value: string;
  placeholder: string;
  onValueChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onCompositionStart: () => void;
  onCompositionEnd: (value: string, cursorPos: number) => void;
}

/**
 * 输入框独立 memo：流式 token 刷新 ChatPanel 时，只要草稿没变就跳过 textarea
 * 重渲染，避免 IME 组字和光标被消息列表带着抖。
 * 拖放由外层 composer 承接（须在 dragover 里 preventDefault，drop 才会触发）。
 */
export const ChatInputTextarea = memo(forwardRef<HTMLTextAreaElement, ChatInputTextareaProps>(
  function ChatInputTextarea(
    {
      value,
      placeholder,
      onValueChange,
      onKeyDown,
      onPaste,
      onCompositionStart,
      onCompositionEnd,
    },
    ref,
  ) {
    useEffect(() => {
      const el = typeof ref === 'function' ? null : ref?.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 80)}px`;
    }, [value, ref]);

    return (
      <textarea
        ref={ref}
        className="w-full bg-raised text-fg placeholder-slate-600 outline-none resize-none text-[15px] leading-relaxed overflow-y-auto min-h-[44px] max-h-[80px]"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={(event) => {
          const target = event.currentTarget;
          onCompositionEnd(target.value, target.selectionStart);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
    );
  },
));
ChatInputTextarea.displayName = 'ChatInputTextarea';
