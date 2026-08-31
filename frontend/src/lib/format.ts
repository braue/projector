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

/**
 * "Aug 31, 2026 at 6:42:07 PM" — when a source landed in the project. Lives in
 * hover titles rather than the row itself: it is the answer to "which upload
 * is this, the one from this morning?", which is worth a hover and not worth
 * a line of every sidebar row.
 *
 * Seconds are not noise here, they are the point: two uploads of the SAME
 * settings file share a display name, so this string is the only thing that
 * tells them apart — and re-uploading twice inside a minute is exactly what
 * fixing a mistake looks like.
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
