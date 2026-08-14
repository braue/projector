import type { StToken } from '../lib/st'

// Spans for one tokenized ST line. Plain tokens skip the wrapper span so the
// common case (identifiers, punctuation) adds no styling nodes.
export function StText({ tokens }: { tokens: StToken[] }) {
  return (
    <>
      {tokens.map((token, i) =>
        token.kind === 'plain' ? (
          token.text
        ) : (
          <span key={i} className={`tok-${token.kind}`}>
            {token.text}
          </span>
        ),
      )}
    </>
  )
}
