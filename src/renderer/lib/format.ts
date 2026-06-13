/** Compact relative time, e.g. "now", "4m", "3h", "2d", "16d". */
export function relTime(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 45) return 'now'
  const m = s / 60
  if (m < 60) return `${Math.round(m)}m`
  const h = m / 60
  if (h < 24) return `${Math.round(h)}h`
  const d = h / 24
  if (d < 30) return `${Math.round(d)}d`
  const mo = d / 30
  if (mo < 12) return `${Math.round(mo)}mo`
  return `${Math.round(d / 365)}y`
}

/**
 * Local clock time for a transcript group header, e.g. "2:34 PM". Takes an ISO 8601 string (a
 * message timestamp) and returns '' for missing/unparseable input so callers can omit it cleanly.
 */
export function clockTime(iso: string | null): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** Full local date + time for the timestamp's hover tooltip, e.g. "Thu, Jun 5, 2026, 2:34:07 PM". */
export function fullDateTime(iso: string | null): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  return new Date(t).toLocaleString([], {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  })
}

/** Last path segment, e.g. "/path/to/repo" -> "repo". */
export function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

/** Human-readable byte size, e.g. "892 B", "14 KB", "1.2 MB". One decimal under 10 units. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const kb = n / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
  const gb = mb / 1024
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`
}

/** Compact elapsed duration from milliseconds, e.g. "<1m", "45m", "3h 12m", "2d 4h". */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return '<1m'
  const totalMin = Math.floor(ms / 60_000)
  const min = totalMin % 60
  const totalHr = Math.floor(totalMin / 60)
  const hr = totalHr % 24
  const days = Math.floor(totalHr / 24)
  if (days > 0) return hr > 0 ? `${days}d ${hr}h` : `${days}d`
  if (totalHr > 0) return min > 0 ? `${totalHr}h ${min}m` : `${totalHr}h`
  return `${min}m`
}

/** Compact count with a metric prefix, e.g. 942 -> "942", 5200 -> "5.2K", 324315 -> "324K",
 *  18389031 -> "18.4M". One decimal under 100 of a unit; the exact count belongs in a tooltip. */
export function formatMetric(n: number): string {
  const units: [number, string][] = [
    [1e9, 'G'],
    [1e6, 'M'],
    [1e3, 'K']
  ]
  for (const [div, suffix] of units) {
    if (n >= div) {
      const v = n / div
      const s = v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '')
      return `${s}${suffix}`
    }
  }
  return String(n)
}

/** Compact absolute local date+time (no weekday/seconds), e.g. "Jun 12, 2026, 11:17 PM". */
export function absShort(ms: number): string {
  return new Date(ms).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}
