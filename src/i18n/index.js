import zhHantBase from './zh-Hant.js';
import zhHantPedals from './zh-Hant.pedals.js';
import zhHantMenu from './zh-Hant.menu.js';

const zhHant = { ...zhHantBase, ...zhHantPedals, ...zhHantMenu };

const LOCALES = { 'zh-Hant': zhHant };
let current = zhHant;

export function setLocale(id) {
  if (LOCALES[id]) current = LOCALES[id];
}

export function t(key, params) {
  const text = current[key] ?? zhHant[key] ?? key;
  return params ? text.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? '') : text;
}

// Fills every element carrying data-i18n with its translated text.
export function applyTranslations(root = document) {
  for (const element of root.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
  document.title = t('app.title');
}
