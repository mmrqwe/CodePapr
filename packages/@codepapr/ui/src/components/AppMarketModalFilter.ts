import type { Lang } from '../utils/i18n';
import type { PaprAppListing } from '../utils/marketAppTypes';
import { listingTitle, listingDescription } from './AppMarketModalCopy';

export function filterMarketListings(
  appListings: PaprAppListing[],
  kindFilter: 'all' | 'plugin' | 'app',
  selectedTag: string | null,
  searchQuery: string,
  lang: Lang | undefined,
): PaprAppListing[] {
  const q = searchQuery.trim().toLowerCase();
  return appListings.filter((app) => {
    if (kindFilter !== 'all' && app.kind !== kindFilter) return false;
    if (selectedTag && (!Array.isArray(app.tags) || !app.tags.includes(selectedTag))) return false;
    if (q) {
      const matchTitle = listingTitle(app, lang).toLowerCase().includes(q);
      const matchTitleEn = (app.titleEn || '').toLowerCase().includes(q);
      const matchDesc = listingDescription(app, lang).toLowerCase().includes(q);
      const matchDescEn = (app.descriptionEn || '').toLowerCase().includes(q);
      const matchId = app.id.toLowerCase().includes(q);
      const matchTags = Array.isArray(app.tags) && app.tags.some((t) => t.toLowerCase().includes(q));
      if (!matchTitle && !matchTitleEn && !matchDesc && !matchDescEn && !matchId && !matchTags) return false;
    }
    return true;
  });
}
