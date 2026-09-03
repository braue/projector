/** "3 matches", "1 note" — a count with its correctly pluralized noun. */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`
}

/** "512 B" / "3.4 KB" / "1.2 MB" — file sizes in the Files views. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** "Aug 31" — the tightest stamp, for collapsed tree rows where width is
 * precious; the time lives on hover and in the expanded version rows. */
export function formatDay(ms: number): string {
  const when = new Date(ms)
  const now = new Date()
  return when.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(when.getFullYear() !== now.getFullYear() ? { year: '2-digit' } : {}),
  })
}

/**
 * "Aug 31 · 6:42 PM" — the compact inline stamp version rows wear. Every
 * version shows its time at a glance; the full seconds-bearing string
 * (formatWhen) rides the hover title for the "which of these two uploads
 * from the same minute" question.
 */
export function formatStamp(ms: number): string {
  const when = new Date(ms)
  const now = new Date()
  const date = when.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(when.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  })
  const time = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${date} · ${time}`
}

/**
 * "Aug 31, 2026 at 6:42:07 PM" — the full landing time, for hover titles.
 *
 * Seconds are not noise here, they are the point: two versions of one
 * settings file differ only in when they landed — and re-uploading twice
 * inside a minute is exactly what fixing a mistake looks like.
 */
export function formatWhen(ms: number): string {
  const when = new Date(ms)
  const date = when.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  const time = when.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })
  return `${date} at ${time}`
}
