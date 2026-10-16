import { invalidArgument } from './errors';

/**
 * Key names agents commonly use (DOM / Playwright / Windows style) mapped to
 * X keysyms that xdotool understands. Anything else must already be a valid
 * keysym (e.g. `F5`, `a`, `Home`).
 */
const KEY_ALIASES: Record<string, string> = {
  enter: 'Return',
  return: 'Return',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  space: 'space',
  backspace: 'BackSpace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'Prior',
  pagedown: 'Next',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  plus: 'plus',
  minus: 'minus',
};

const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  cmd: 'ctrl',
  command: 'ctrl',
  cmdorctrl: 'ctrl',
  meta: 'super',
  super: 'super',
  win: 'super',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
};

/** One chord like `ctrl+shift+t` or `Enter` → xdotool form `ctrl+shift+t` / `Return`. */
export function toXdotoolChord(chord: string): string {
  const parts = chord
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) throw invalidArgument(`empty key "${chord}"`);
  const key = parts.pop() as string;
  const mods = parts.map((m) => {
    const mod = MODIFIER_ALIASES[m.toLowerCase()];
    if (!mod) throw invalidArgument(`unknown modifier "${m}" in "${chord}"`);
    return mod;
  });
  const mapped = KEY_ALIASES[key.toLowerCase()] ?? key;
  if (!/^[A-Za-z0-9_]+$/.test(mapped) && mapped.length !== 1) {
    throw invalidArgument(`unknown key "${key}"`);
  }
  return [...mods, mapped].join('+');
}

/** Space-separated sequence (`ctrl+l Delete`) → list of xdotool chords. */
export function parseKeySequence(keys: string): string[] {
  const chords = keys.trim().split(/\s+/).filter(Boolean);
  if (chords.length === 0) throw invalidArgument('keys is empty');
  if (chords.length > 20) throw invalidArgument('at most 20 key chords per call');
  return chords.map(toXdotoolChord);
}

/** Modifier list for clicks (`ctrl`, `shift+alt`) → xdotool modifier keysyms. */
export function parseModifiers(modifiers: string | undefined): string[] {
  if (!modifiers) return [];
  return modifiers
    .split('+')
    .map((m) => m.trim())
    .filter(Boolean)
    .map((m) => {
      const mod = MODIFIER_ALIASES[m.toLowerCase()];
      if (!mod) throw invalidArgument(`unknown modifier "${m}"`);
      return mod;
    });
}
