// The SEL part-lookup client both corpus scripts (fetch-sel-dwgs,
// audit-sel-metadata) speak — one home for the endpoint, the headers, and
// the wrong-length retry rule, so an API or Incapsula change lands once.

const PART_LOOKUP_URL = (pn) =>
  `https://selinc.com/api/configurator/part-lookup/?partQuery=${encodeURIComponent(pn)}`;

// Requests are serialized with a pause between them. These scripts run
// rarely against someone else's servers; there is no reason to be greedy.
const DEFAULT_DELAY_MS = 1500;

// A browser UA, not an identifying one: selinc.com fronts with Incapsula,
// which binds the session cookies to the browser fingerprint they were
// minted under and rejects the same cookies presented with a non-browser UA
// (and dislikes obvious bots even on the anonymous endpoint).
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** One raw part-lookup call; callers own caching and pacing. */
async function fetchPartLookup(pn) {
  const response = await fetch(PART_LOOKUP_URL(pn), {
    headers: { 'User-Agent': USER_AGENT, Referer: 'https://selinc.com/', Accept: 'application/json' },
  });
  if (response.status !== 200) throw new Error(`part-lookup HTTP ${response.status} for ${pn}`);
  return response.json();
}

// The API rejects a wrong-length part number with one code-14 error per
// submodel, each naming the length that submodel expects. An X in any option
// position means "unspecified" to the configurator, so padding a short part
// number with X is a legitimate way to address the longer submodels.
function lengthHints(response, pn) {
  const hints = new Set();
  for (const error of response?.errors ?? []) {
    const match = /should be (\d+) characters/.exec(error.message ?? '');
    if (match && Number(match[1]) > pn.length) hints.add(Number(match[1]));
  }
  return [...hints].sort((a, b) => a - b).map((len) => pn + 'X'.repeat(len - pn.length));
}

export { DEFAULT_DELAY_MS, PART_LOOKUP_URL, USER_AGENT, fetchPartLookup, lengthHints };
