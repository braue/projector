// Case-insensitive <mark> of every occurrence of `query` — shared by the
// Inspect/Notes/Files search panes.
export function Highlight({ text, query }: { text: string; query: string }) {
  const lower = text.toLowerCase()
  const needle = query.toLowerCase()
  if (!needle) return <>{text}</>
  const parts: React.ReactNode[] = []
  let from = 0
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
    if (at > from) parts.push(text.slice(from, at))
    parts.push(<mark key={at}>{text.slice(at, at + needle.length)}</mark>)
    from = at + needle.length
  }
  parts.push(text.slice(from))
  return <>{parts}</>
}
