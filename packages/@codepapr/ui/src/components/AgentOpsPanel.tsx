import { useEffect, useState } from 'react';
import { useAgentStore } from '../store/agentStore';
import { useCharactersStore } from '../store/charactersStore';
import { useThemeStore } from '../store/themeStore';
import { listMcpServerStatus } from '../tools/mcpTools';
import { getTranslation, type Lang } from '../utils/i18n';
import { ConversationSearch } from './ConversationSearch';
import type { PreviewLocation } from '../utils/projectDiagnosticLocations';

function getOpsCopy(lang: Lang | undefined) {
  switch (lang) {
    case 'en':
      return { idle: 'Idle', active: 'Running' };
    case 'zh-TW':
      return { idle: '空閒', active: '執行中' };
    default:
      return { idle: '空闲', active: '执行中' };
  }
}

interface AgentOpsPanelProps {
  onOpenMcpSettings: () => void;
  onOpenCharacters: () => void;
  onOpenStats: () => void;
  onOpenAbout: () => void;
  onNavigateToFile: (location: PreviewLocation) => void;
}

export function AgentOpsPanel({
  onOpenMcpSettings, onOpenCharacters, onOpenStats,
  onOpenAbout, onNavigateToFile,
}: AgentOpsPanelProps) {
  const settings = useAgentStore((state) => state.settings);
  const isLoading = useAgentStore((state) => state.isLoading);
  const mode = useThemeStore((state) => state.mode);
  const t = getTranslation(settings.lang);
  const copy = getOpsCopy(settings.lang);
  const activeCharacterId = useCharactersStore((state) => state.activeCharacterId);
  const activeCharacter = useCharactersStore((state) =>
    state.characters.find((c) => c.id === state.activeCharacterId) ?? null
  );
  const [mcpConnected, setMcpConnected] = useState(0);

  useEffect(() => {
    if (!settings.mcp.enabled) {
      setMcpConnected(0);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const status = await listMcpServerStatus(settings.mcp);
        if (!cancelled) {
          setMcpConnected(status.filter((server) => server.connected).length);
        }
      } catch {
        if (!cancelled) setMcpConnected(0);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [settings.mcp]);

  const buttonClass = 'flex-shrink-0 rounded-lg border border-line px-2.5 py-2 text-xs font-medium text-fg-soft transition-colors hover:border-accent hover:text-fg';
  const characterButtonClass = activeCharacterId
    ? 'flex-shrink-0 rounded-lg border border-ok-bg bg-ok-bg px-2.5 py-2 text-xs font-medium text-ok transition-colors hover:bg-ok-bg'
    : buttonClass;

  return (
    <div className="flex items-center border-b border-line px-4 min-h-[60px]">
      <div className="flex items-center gap-2 overflow-x-auto">
        <button
          type="button"
          onClick={() => useThemeStore.getState().toggleMode()}
          title={t.themeToggleTip}
          className={buttonClass}
        >
          {mode === 'dark' ? '\u2600\uFE0F' : '\uD83C\uDF19'}
        </button>
        {settings.experimentalCharacters && (
        <button type="button" onClick={onOpenCharacters} title={t.charactersTip} className={characterButtonClass}>
          <span className="flex items-center gap-1.5">
            <span>{t.characters}</span>
            {activeCharacter && <span className="max-w-[120px] truncate text-[10px] font-semibold opacity-80">· {activeCharacter.name}</span>}
          </span>
        </button>
        )}
        <button type="button" onClick={onOpenMcpSettings} title={settings.lang === 'en' ? 'Configure MCP servers and exposed tools.' : settings.lang === 'zh-TW' ? '配置 MCP 服務與暴露工具。' : '配置 MCP 服务与暴露工具。'} className={buttonClass}>
          <span className="flex items-center gap-1.5">
            <span>MCP</span>
            {settings.mcp.enabled && (
              <span
                className={`inline-block h-2 w-2 rounded-full ${mcpConnected > 0 ? 'bg-ok' : 'bg-slate-500'}`}
                title={settings.lang === 'en' ? `${mcpConnected} connected` : settings.lang === 'zh-TW' ? `${mcpConnected} 已連線` : `${mcpConnected} 已连接`}
              />
            )}
            {mcpConnected > 0 && (
              <span className="text-[10px] font-semibold text-ok">{mcpConnected}</span>
            )}
          </span>
        </button>
        <button type="button" onClick={onOpenStats} title={t.statsButtonTip} className={buttonClass}>
          {t.projectStats}
        </button>
        <div className="flex min-w-[76px] flex-shrink-0 items-center gap-2 rounded-lg border border-line px-2.5 py-2" title={isLoading ? copy.active : copy.idle}>
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${isLoading ? 'animate-pulse bg-warn' : 'bg-ok'}`} />
          <span className="text-xs font-medium text-fg-muted">{isLoading ? copy.active : copy.idle}</span>
        </div>
        <ConversationSearch onNavigateToFile={onNavigateToFile} />
        <button type="button" onClick={onOpenAbout} title="About" className={buttonClass}>{'ⓘ'}</button>
      </div>
    </div>
  );
}
