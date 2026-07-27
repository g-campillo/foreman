/**
 * Reading theme.css's colour tokens back out as literals.
 *
 * Nothing in the app should need this — CSS custom properties are the whole
 * point of theme.css, and every component uses `rgb(var(--x))` directly. The
 * exceptions are widgets that own their own rendering and take colour as data:
 * xterm wants `rgb(r,g,b)` strings, Monaco wants hex. Neither resolves a
 * `var()`, so both have to be handed values.
 *
 * That makes this the seam where a theme change has to be re-applied by hand,
 * which is why `store.resolvedTheme` exists as a store field rather than being
 * left to CSS: it is the dependency those re-theming effects watch.
 *
 * Tokens are stored space-separated ("10 132 255"), and border tokens carry a
 * baked-in alpha ("255 255 255 / 0.09"). Both forms have to survive here.
 */

export function vars(): CSSStyleDeclaration {
  return getComputedStyle(document.documentElement)
}

/** A token's raw text, for the non-colour ones like --mono and --font. */
export function raw(css: CSSStyleDeclaration, name: string): string {
  return css.getPropertyValue(name).trim()
}

/** `[r, g, b, a]`, understanding both "r g b" and "r g b / a". */
function channels(css: CSSStyleDeclaration, name: string): [number, number, number, number] {
  const [rgb, alpha] = css.getPropertyValue(name).trim().split('/')
  const parts = (rgb ?? '').trim().split(/\s+/).map(Number)
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, alpha === undefined ? 1 : Number(alpha)]
}

/**
 * `rgb(r,g,b)` / `rgba(r,g,b,a)` — the legacy comma forms.
 *
 * xterm's colour parser does NOT understand CSS Color 4's space-separated
 * `rgb(10 132 255 / .35)`, which is what theme.css stores. Hence the rejoin.
 */
export function token(css: CSSStyleDeclaration, name: string, alpha?: number): string {
  const ch = css.getPropertyValue(name).trim().split(/\s+/).join(',')
  return alpha === undefined ? `rgb(${ch})` : `rgba(${ch},${alpha})`
}

/**
 * `#rrggbb`, or `#rrggbbaa` when an alpha is in play.
 *
 * Monaco's theme takes hex and nothing else. Note the asymmetry in its own API,
 * which is easy to get backwards: `rules[].foreground` wants hex WITHOUT the
 * leading `#`, while `colors[key]` wants it WITH one. Callers slice.
 *
 * The `/ alpha` form is why this cannot be `token()` with a regex swap: naively
 * splitting "--border" on whitespace yields "255,255,255,/,0.09", which is not
 * a colour in any syntax.
 */
export function hex(css: CSSStyleDeclaration, name: string, alpha?: number): string {
  const [r, g, b, a] = channels(css, name)
  const on = alpha ?? a
  const pair = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0')
  const base = `#${pair(r)}${pair(g)}${pair(b)}`
  return on >= 1 ? base : `${base}${pair(on * 255)}`
}
