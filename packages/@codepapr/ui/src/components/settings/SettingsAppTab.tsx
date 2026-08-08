import type { PaprAppSettings } from '@codepapr/types';
import { AppPermissionsTab } from '../AppPermissionsTab';
import type { Lang } from '../../utils/i18n';

interface SettingsAppTabProps {
  currentLang: Lang;
  value: PaprAppSettings | null;
  onChange: (settings: PaprAppSettings) => void;
  loadError: string;
}

export function SettingsAppTab({ currentLang, value, onChange, loadError }: SettingsAppTabProps) {
  return (
    <div className="flex flex-col gap-4">
      <AppPermissionsTab
        lang={currentLang}
        value={value}
        onChange={onChange}
        loadError={loadError}
      />
    </div>
  );
}
