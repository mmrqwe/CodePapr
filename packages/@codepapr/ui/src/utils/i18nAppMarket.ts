import type { Lang } from './i18n';

/** Market/dock strings to merge until i18n.ts can take a full patched upload. */
export const I18N_APP_MARKET: Record<Lang, {
  settingsAppMarketTitle: string;
  settingsAppMarketDesc: string;
  settingsAppBrowseMarket: string;
}> = {
  'zh-CN': {
    settingsAppMarketTitle: '应用与插件市场',
    settingsAppMarketDesc: '发现并安装官方与社区的原生 UI 插件、数据看板及桌面独立微应用。',
    settingsAppBrowseMarket: '浏览 App 市场',
  },
  'zh-TW': {
    settingsAppMarketTitle: '應用與外掛市場',
    settingsAppMarketDesc: '探索並安裝官方與社群的原生 UI 外掛、資料看板及桌面獨立微應用。',
    settingsAppBrowseMarket: '瀏覽 App 市場',
  },
  en: {
    settingsAppMarketTitle: 'App & Plugin Market',
    settingsAppMarketDesc: 'Discover and install native UI plugins, visual canvases, and standalone desktop micro-apps.',
    settingsAppBrowseMarket: 'Browse App Market',
  },
};
