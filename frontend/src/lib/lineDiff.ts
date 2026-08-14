// Minimal LCS line diff for logic source bodies (ST programs run to a few
// hundred lines at most, so the quadratic table is fine).

export type DiffLine = {
  kind: 'same' | 'add' | 'del'
  text: string
  /** 1-based line number in the original (absent on added lines). */
  oldNo?: number
  /** 1-based line number in the new source (absent on deleted lines). */
  newNo?: number
}

export function lineDiff(originalText: string, updatedText: string): DiffLine[] {
  const a = originalText.split('\n')
  const b = updatedText.split('\n')

  const rows = a.length + 1
  const cols = b.length + 1
  const lcs = new Uint32Array(rows * cols)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * cols + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * cols + j + 1] + 1
          : Math.max(lcs[(i + 1) * cols + j], lcs[i * cols + j + 1])
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i], oldNo: i + 1, newNo: j + 1 })
      i++
      j++
    } else if (lcs[(i + 1) * cols + j] >= lcs[i * cols + j + 1]) {
      out.push({ kind: 'del', text: a[i], oldNo: i + 1 })
      i++
    } else {
      out.push({ kind: 'add', text: b[j], newNo: j + 1 })
      j++
    }
  }
  for (; i < a.length; i++) out.push({ kind: 'del', text: a[i], oldNo: i + 1 })
  for (; j < b.length; j++) out.push({ kind: 'add', text: b[j], newNo: j + 1 })
  return out
}
