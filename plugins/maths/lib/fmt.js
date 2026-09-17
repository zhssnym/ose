/* The two spellings that are this plugin's own. Everything else a duration or a date is
   written in comes from the shared lib (`duration`, `clockText`, `ymd`, `stamp`, `median`). */

/**
 * A thinking time: a small number of seconds that wants one decimal, because a median of
 * `8.4 s` and a median of `8.9 s` are different news and `8 s` hides it. It is the number the
 * whole exercise exists to produce (0-index.md), so it is the one that keeps its precision.
 */
export function think(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < 60000) return `${(value / 1000).toFixed(1)} s`
  const total = Math.round(value / 1000)
  return `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, '0')}`
}

/** `16/09/2026`: the way `bilan.md` and Hassan's own files date themselves. File content. */
export function frenchDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`
}
