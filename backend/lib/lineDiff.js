// Minimal LCS line diff for logic source bodies — backend twin of
// frontend/src/lib/lineDiff.ts (the app's DiffPreview renders the same
// diff). Keep the two in lockstep so the PDF report and the on-screen diff
// always show ONE diff: same removed/added sets, same line numbers.
//
// Lines carry `kind` ('same' | 'add' | 'del') plus 1-based `oldNo` (absent
// on added lines) and `newNo` (absent on deleted lines).

function lineDiff(originalText, updatedText) {
  // An empty side has NO lines — a part that exists on only one side must
  // not fabricate a phantom deleted/added blank line 1.
  const a = originalText === '' ? [] : originalText.split('\n');
  const b = updatedText === '' ? [] : updatedText.split('\n');

  const cols = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * cols + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * cols + j + 1] + 1
          : Math.max(lcs[(i + 1) * cols + j], lcs[i * cols + j + 1]);
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i], oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (lcs[(i + 1) * cols + j] >= lcs[i * cols + j + 1]) {
      out.push({ kind: 'del', text: a[i], oldNo: i + 1 });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j], newNo: j + 1 });
      j++;
    }
  }
  for (; i < a.length; i++) out.push({ kind: 'del', text: a[i], oldNo: i + 1 });
  for (; j < b.length; j++) out.push({ kind: 'add', text: b[j], newNo: j + 1 });
  return out;
}

export { lineDiff };
