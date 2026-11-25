// Player preferences chosen with the on-page buttons (or their keys), remembered in localStorage
// so they survive a reload. Pure: storage and the URL query are passed in.
//
// Order of precedence at startup: URL developer flag > remembered choice > SETTINGS default.
// URL flags only apply to this visit and are never written back; a remembered value changes only
// when the player picks something.

export const PREFS_KEY = 'airJam.prefs.v1';

const bool = v => typeof v === 'boolean';

/**
 * Remembered preferences and how to validate them. `tones` and `snapModes` are the choices the
 * buttons offer (lab tones only come from the URL and are never remembered).
 */
export function prefSpec({ tones, snapModes }) {
  return {
    tone: v => tones.includes(v),
    snapMode: v => snapModes.includes(v),
    metronome: bool,
    showHand: bool,
    keyGuard: bool,
    pedals: bool,
    handedness: v => v === 'right' || v === 'left',
    mouse: bool,
  };
}

// Keeps only known keys with valid values; anything else (old versions, garbage) is dropped.
export function sanitizePrefs(data, spec) {
  const prefs = {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) return prefs;
  for (const [key, valid] of Object.entries(spec)) if (key in data && valid(data[key])) prefs[key] = data[key];
  return prefs;
}

export function loadPrefs(storage, spec, key = PREFS_KEY) {
  try {
    const text = storage?.getItem(key);
    return text ? sanitizePrefs(JSON.parse(text), spec) : {};
  } catch {
    return {};
  }
}

export function savePrefs(storage, prefs, key = PREFS_KEY) {
  try {
    storage?.setItem(key, JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}

/**
 * Developer URL flags (hidden options; nothing needs them):
 *   ?mouse=1|0  ?tone=<any tone id, incl. labA..labD>  ?keyguard=off|on  ?pedals=1|0
 * @param {URLSearchParams} query
 * @param {string[]} allTones  every tone the game can play
 */
export function urlOverrides(query, allTones) {
  const out = {};
  const flag = (name, on, off) => {
    const value = query.get(name);
    return value === on ? true : value === off ? false : undefined;
  };
  const mouse = flag('mouse', '1', '0');
  if (mouse !== undefined) out.mouse = mouse;
  const tone = query.get('tone');
  if (tone && allTones.includes(tone)) out.tone = tone;
  const keyGuard = flag('keyguard', 'on', 'off');
  if (keyGuard !== undefined) out.keyGuard = keyGuard;
  const pedals = flag('pedals', '1', '0');
  if (pedals !== undefined) out.pedals = pedals;
  return out;
}

/**
 * The values to start with. `defaults` are the SETTINGS fields (plus mouse: false).
 * @returns {{ values: object, fromUrl: Set<string> }}
 */
export function resolvePrefs(defaults, stored, overrides) {
  const values = {};
  for (const key of Object.keys(defaults)) values[key] = key in overrides ? overrides[key] : key in stored ? stored[key] : defaults[key];
  return { values, fromUrl: new Set(Object.keys(overrides)) };
}

/**
 * The store the game uses: remember(key, value) writes one choice; values from the URL are not
 * written unless the player changes that setting.
 */
export function createPrefs({ storage, spec, defaults, query, allTones }) {
  const stored = loadPrefs(storage, spec);
  const { values, fromUrl } = resolvePrefs(defaults, stored, urlOverrides(query, allTones));
  return {
    values,
    fromUrl,
    stored: () => ({ ...stored }),
    remember(key, value) {
      if (!(key in spec) || !spec[key](value)) return false;
      stored[key] = value;
      return savePrefs(storage, stored);
    },
  };
}
