import type { Settings } from '../../store/agentStore';
import type { Lang } from '../../utils/i18n';
import { getTranslation } from '../../utils/i18n';

export type SettingsTab = 'general' | 'llm' | 'search' | 'mentor' | 'advanced' | 'app';

export type Translation = ReturnType<typeof getTranslation>;

export interface SettingsTabProps {
  local: Settings;
  update: (partial: Partial<Settings>) => void;
  t: Translation;
  currentLang: Lang;
}
