export const THEME_STORAGE_KEY = 'sx-theme';
export const MOTION_STORAGE_KEY = 'sx-motion';

/**
 * Inline script executed before first paint so the correct theme renders
 * without a flash. Order of precedence: authenticated profile preference
 * (rendered into `data-theme-server`), then the local anonymous preference,
 * then the system preference. Admin brand defaults never overwrite a user's
 * stored choice.
 */
export function themeInitScript(): string {
  return `(function(){try{var d=document.documentElement;var s=d.getAttribute('data-theme-server');var t=s||localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='light'||t==='dark'){d.setAttribute('data-theme',t);}else{d.removeAttribute('data-theme');}var m=d.getAttribute('data-motion-server')||localStorage.getItem('${MOTION_STORAGE_KEY}');if(m==='reduce'||m==='full'){d.setAttribute('data-motion',m);}}catch(e){}})();`;
}
