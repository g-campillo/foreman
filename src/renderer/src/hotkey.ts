/**
 * A control's tooltip and its keycap, from one call.
 *
 * The cap is DECLARED as its own `data-key`, not parsed out of the tip — see
 * useKeyPeek for the argument. This helper exists so the two cannot drift: the
 * tip's trailing shortcut and the cap are the same string by construction, and a
 * control that gains a shortcut cannot gain it in only one of the two places.
 *
 * Two spaces before the key, matching the convention every hand-written tip in
 * the app already uses ('Send  ⏎').
 */
export const hk = (
  tip: string,
  key: string,
): { 'data-tip': string; 'data-key': string } => ({
  'data-tip': `${tip}  ${key}`,
  'data-key': key,
})
