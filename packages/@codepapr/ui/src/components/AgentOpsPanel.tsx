import { useAgentStore } from '../store/agentStore';
import { useCharactersStore } from '../store/charactersStore';
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
  onOpenSettings: () => void;
  onOpenMcpSettings: () => void;
  onOpenCharacters: () => void;
  onOpenCacheStats: () => void;
  onOpenAbout: () => void;
  isDark: boolean;
  onToggleTheme: () => void;
  onNavigateToFile: (location: PreviewLocation) => void;
}

export function AgentOpsPanel({
  onOpenSettings, onOpenMcpSettings, onOpenCharacters, onOpenCacheStats,
  onOpenAbout, isDark, onToggleTheme, onNavigateToFile,
}: AgentOpsPanelProps) {
  const { settings, isLoading } = useAgentStore();
  const t = getTranslation(settings.lang);
  const copy = getOpsCopy(settings.lang);
  const activeCharacterId = useCharactersStore((state) => state.activeCharacterId);
  const activeCharacter = useCharactersStore((state) =>
    state.characters.find((c) => c.id === state.activeCharacterId) ?? null
  );

  const buttonClass = 'flex-shrink-0 rounded-lg border border-[#2a2d3a] px-2.5 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-indigo-400 hover:text-white';
  const characterButtonClass = activeCharacterId
    ? 'flex-shrink-0 rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-2.5 py-2 text-xs font-medium text-emerald-100 transition-colors hover:bg-emerald-500/20'
    : buttonClass;

  return (
    <div className="flex items-center border-b border-[#202432] px-4 min-h-[60px]">
      <div className="flex items-center gap-2 overflow-x-auto">
        <button type="button" onClick={onToggleTheme} title={isDark ? '切换到浅色主题' : '切换到深色主题'} className={buttonClass}>
          {isDark ? '\u2600\uFE0F' : '\uD83C\uDF19'}
        </button>
        <button type="button" onClick={onOpenSettings} title={t.settingsTip} className={buttonClass}>
          <span>{t.modelSettings}</span>
        </button>
        <button type="button" onClick={onOpenCharacters} title={t.charactersTip} className={characterButtonClass}>
          <span className="flex items-center gap-1.5">
            <span>{t.characters}</span>
            {activeCharacter && <span className="max-w-[120px] truncate text-[10px] font-semibold opacity-80">· {activeCharacter.name}</span>}
          </span>
        </button>
        <button type="button" onClick={onOpenMcpSettings} title={settings.lang === 'en' ? 'Configure MCP servers and exposed tools.' : settings.lang === 'zh-TW' ? '配置 MCP 服務與暴露工具。' : '配置 MCP 服务与暴露工具。'} className={buttonClass}>
          <span>MCP</span>
        </button>
        <button type="button" onClick={onOpenCacheStats} title={t.cacheStatsTip} className={buttonClass}>
          {t.cacheStatsTitle}
        </button>
        <div className="flex min-w-[76px] flex-shrink-0 items-center gap-2 rounded-lg border border-[#2a2d3a] px-2.5 py-2" title={isLoading ? copy.active : copy.idle}>
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${isLoading ? 'animate-pulse bg-amber-300' : 'bg-emerald-300'}`} />
          <span className="text-xs font-medium text-slate-400">{isLoading ? copy.active : copy.idle}</span>
        </div>
        <ConversationSearch onNavigateToFile={onNavigateToFile} />
        <button type="button" onClick={onOpenAbout} title="About" className={buttonClass}>{'ⓘ'}</button>
      </div>
    </div>
  );
}
