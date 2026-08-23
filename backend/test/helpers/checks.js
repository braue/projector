// Reading a link's checklist in tests.
//
// Every link carries `checks` — the whole list of questions the linker asked,
// each with the answer it got. Tests usually care about one of two things:
// which questions came back badly, or what one named question said.

/** Checks that came back badly: a disagreement, or something worth flagging. */
function problems(link) {
  return (link.checks ?? []).filter((entry) => entry.status === 'fail' || entry.status === 'warn');
}

/** Just the disagreements — the ones that make a link a conflict. */
function failures(link) {
  return (link.checks ?? []).filter((entry) => entry.status === 'fail');
}

/** One named check, or undefined if the linker never asked that question. */
function checkFor(link, label) {
  return (link.checks ?? []).find((entry) => entry.label === label);
}

/** Every check as "Label: status", for asserting on the shape of the list. */
function statuses(link) {
  return (link.checks ?? []).map((entry) => `${entry.label}: ${entry.status}`);
}

/** All the detail text joined, for a loose match on wording. */
function details(link) {
  return (link.checks ?? []).map((entry) => entry.detail).join(' | ');
}

export { checkFor, details, failures, problems, statuses };
