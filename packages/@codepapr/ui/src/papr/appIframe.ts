/** App iframe sandbox flags.
 *  `allow-downloads` is required for `<a download>` / programmatic saves;
 *  Chromium silently drops those without this token, independent of papr permissions. */
export const APP_IFRAME_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads';

/** Preview of an arbitrary (non-app) URL: no same-origin, still allow downloads. */
export const PREVIEW_IFRAME_SANDBOX = 'allow-scripts allow-forms allow-modals allow-downloads';
