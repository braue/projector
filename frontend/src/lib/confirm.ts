// The overwrite confirmation both RTAC ingestion paths share (database
// download and folder upload) — a same-name source is never replaced silently.

/** True when nothing collides or the user approves; `withWhat` finishes the
 * question ("this upload", "a fresh download"). */
export function confirmOverwrite(names: string[], withWhat: string): boolean {
  if (!names.length) return true
  const message = names.length === 1
    ? `"${names[0]}" is already in this project. Overwrite it with ${withWhat}?`
    : `${names.length} of the selection are already in this project (${names.join(', ')}). Overwrite them with ${withWhat}?`
  return window.confirm(message)
}
