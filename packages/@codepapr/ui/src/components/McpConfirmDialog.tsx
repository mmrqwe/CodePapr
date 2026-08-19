import { useAgentStore } from '../store/agentStore';
import { useMcpConfirmStore } from '../store/mcpConfirmStore';
import type { Lang } from '../utils/i18n';

function copy(lang: Lang | undefined) {
  if (lang === 'en') {
    return {
      title: 'Confirm MCP action',
      bodyPrefix: 'MCP server',
      bodySuffix: 'wants to run this tool:',
      hint: 'Allowing will run the tool immediately. Denying ends this call as rejected by the user.',
      deny: 'Deny',
      allow: 'Allow',
    };
  }
  if (lang === 'zh-TW') {
    return {
      title: 'MCP 高風險操作確認',
      bodyPrefix: 'MCP 服務',
      bodySuffix: '請求執行工具：',
      hint: '允許後將立即執行該工具；拒絕則本次呼叫以「被使用者拒絕」結束。',
      deny: '拒絕',
      allow: '允許',
    };
  }
  return {
    title: 'MCP 高风险操作确认',
    bodyPrefix: 'MCP 服务',
    bodySuffix: '请求执行工具：',
    hint: '允许后将立即执行该工具；拒绝则本次调用以“被用户拒绝”结束。',
    deny: '拒绝',
    allow: '允许',
  };
}

function formatArguments(args: unknown): string {
  if (args === null || args === undefined) return '';
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

export function McpConfirmDialog() {
  const lang = useAgentStore((s) => s.settings.lang);
  const pendingConfirm = useMcpConfirmStore((s) => s.pendingConfirm);
  const respondToConfirm = useMcpConfirmStore((s) => s.respondToConfirm);
  const c = copy(lang);

  if (!pendingConfirm) return null;

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-overlay p-4 backdrop-blur-sm">
      <div className="flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-base shadow-2xl">
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-sm font-semibold text-fg">{c.title}</h2>
        </div>
        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-5 py-4">
          <p className="text-sm leading-relaxed text-fg-soft">
            {c.bodyPrefix}
            <span className="mx-1 text-accent-text">{pendingConfirm.serverName}</span>
            {c.bodySuffix}
          </p>
          <div className="rounded-lg border border-line bg-deep px-3 py-2.5">
            <code className="break-all text-xs text-info">{pendingConfirm.toolName}</code>
          </div>
          {Object.keys(pendingConfirm.arguments ?? {}).length > 0 && (
            <pre className="max-h-56 overflow-auto rounded-lg border border-line bg-deep p-3 text-xs text-fg-soft">
              {formatArguments(pendingConfirm.arguments)}
            </pre>
          )}
          <p className="text-[11px] leading-relaxed text-fg-muted">
            {c.hint}
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
          <button
            type="button"
            onClick={() => respondToConfirm(false)}
            className="rounded-lg border border-line bg-transparent px-3.5 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:border-danger-bg hover:text-danger"
          >
            {c.deny}
          </button>
          <button
            type="button"
            onClick={() => respondToConfirm(true)}
            className="rounded-lg bg-accent-soft border border-accent-soft px-3.5 py-1.5 text-xs font-medium text-accent-text transition-colors hover:bg-accent-soft hover:border-accent-soft"
          >
            {c.allow}
          </button>
        </div>
      </div>
    </div>
  );
}
