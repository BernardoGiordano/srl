/**
 * Give each name a stable avatar colour, so the same person reads the same on
 * every screen. The tones are soft tints with a matching text colour.
 */

const TONES = [
  'bg-indigo-100 text-indigo-700 dark:bg-indigo-400/20 dark:text-indigo-200',
  'bg-sky-100 text-sky-700 dark:bg-sky-400/20 dark:text-sky-200',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-400/20 dark:text-emerald-200',
  'bg-amber-100 text-amber-800 dark:bg-amber-400/20 dark:text-amber-200',
  'bg-rose-100 text-rose-700 dark:bg-rose-400/20 dark:text-rose-200',
  'bg-violet-100 text-violet-700 dark:bg-violet-400/20 dark:text-violet-200',
  'bg-teal-100 text-teal-700 dark:bg-teal-400/20 dark:text-teal-200',
  'bg-orange-100 text-orange-700 dark:bg-orange-400/20 dark:text-orange-200',
];

/**
 * @param {string | undefined} name
 * @returns {string}
 */
export function avatarTone(name) {
  let hash = 0;
  for (const char of name ?? '') hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return TONES[hash % TONES.length] ?? '';
}
