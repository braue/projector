# Drawing-metadata audit plan

The SEL-487E incident (a genuine MOT, `0487E4X611XXC5X43624XXX`, decoded with
five unrecognized positions and rendered with the WRONG firmware layer and two
layers missing) showed the corpus metadata's weakness: most of it was
reverse-engineered from a handful of sampled units, and a first census finds
**49 of 63 models** carrying at least one of the same defect patterns. This
plan turns the one-off 487E fix into a process.

## Goal

For every model: a real ordered part number decodes with no unrecognized
positions, selects the same drawing PDF the SEL configurator lists for it, and
enables the layer set that matches the configurator's option decode.

## Ground truth, ranked

1. **SEL configurator part-lookup** (`/api/configurator/part-lookup/?partQuery=`,
   public, anonymous — the endpoint `fetch-sel-dwgs.mjs` already uses). One
   query per MOT returns the authoritative decode: every question, the chosen
   answer text, the exact MOT digit positions, and the drawing files for that
   configuration. This is what re-grounded the 487E.
2. **The drawing PDFs' own layer catalogs** (already in each model's
   `model_to_layers`): complete per-group code lists WITH descriptions — the
   layer names are `<order>__<code>__<description>`.
3. **Real fleet MOTs**: PARTNOs from uploaded RDBs and QuickSet Extract dumps,
   the example part numbers already recorded in metadata `when` clauses, and
   the lookup PNs in `dwg-sources.json` (each of those resolved successfully
   against the configurator during the DWG fetch).

## The defect taxonomy (what the census flags)

- **Hardcoded source** (`source: {value: …}`): a layer group that always
  resolves to one fixed option — the 487E firmware bug. ~20 models. Always a
  real output defect for any configuration that differs from the hardcoded one.
- **Wrong source position**: group codes that aren't a subset of the source
  position's option codes usually means the group reads the wrong digit (487E
  read the power supply as the connector). Lint must normalize prefix-style
  keys (`0-`, `2A`) before flagging, or slot-based models false-positive.
- **Double-booked position**: two groups reading the same position with
  disjoint code sets — one of them is wrong.
- **Blob positions** (`length` > ~3 with literal-combo options): observed
  whole-substring matches instead of real fields; misses every unseen combo.
- **Observed-only options** (`confidence: low`, "observed on genuine units"):
  decode-table gaps; cosmetic until a layer group shares the position.

## Process

### Phase 0 — audit harness (`tools/audit-sel-metadata.mjs`)

- `--lint` — the offline checks above, with prefix-key normalization borrowed
  from `selPartNumberRules.js` (`optionKeyMatches`) so slot codes don't
  false-positive. Zero network.
- `--verify [--mots <file>]` — for each MOT: (a) local decode, list unmatched
  positions; (b) local `resolveDrawings` + `resolveEnabledLayers`, capture
  unresolved-group warnings; (c) configurator lookup, then diff — our decode
  labels vs their questions, our PDF choice vs their `drawings[]`. Serialize
  requests ~1.5 s apart (the fetch script's etiquette) and cache every
  response under `tools/audit-cache/` so re-runs are free and offline.
- `--propose <model>` — emit a draft `part_number.positions` rebuild from the
  cached configurator decodes plus the layer catalogs (the 487E procedure,
  scripted). Human-reviewed before it lands; never auto-committed.

### Phase 1 — assemble the MOT corpus

- Sweep what's already on disk: metadata example MOTs, `dwg-sources.json`.
- Sweep the user's data for real PARTNOs (RDB uploads, QuickSet dump runs) —
  real fleet MOTs are the highest-value cases; the 487E bug was found by one.
- For models still uncovered, synthesize one MOT per drawing rule from its
  `when` constraints (as the DWG fetch already does).

### Phase 2 — run and triage

Buckets, worst first:

- **C — drawing-selection mismatch** (we pick a different PDF than SEL): user
  gets the wrong drawing entirely.
- **B — layer defects** (hardcoded/wrong sources): right drawing, wrong or
  missing layers. Start with the ~20 hardcoded-source models.
- **A — decode-only gaps**: "(unrecognized)" rows; cosmetic but trust-eroding.

### Phase 3 — fix loop, per model

1. Rebuild positions from `--propose`, review, land.
2. Correct group sources (`position` / `parts`+`separator` — the resolver
   already supports both; no code changes expected).
3. Pin with a regression test: real MOT → zero unmatched, expected PDF, the
   distinguishing layer names (`tools-dwgen.test.js` has the 487E template).
4. Honesty rule: codes the ground truth doesn't cover get a note ("codes
   undocumented offline"), never an invented meaning.

### Phase 4 — keep it fixed

- Run `--lint` inside a backend test so metadata regressions fail the suite.
- Keep the MOT corpus + audit cache in-repo; after any metadata edit the
  whole verify pass re-runs offline in seconds.
- Dwgen UI: consider surfacing "this model's decode is partly low-confidence"
  instead of bare "(unrecognized)" rows.

## Status

- [x] 487E rebuilt against the configurator; regression test in place.
- [x] Phase 0 harness (`tools/audit-sel-metadata.mjs` — `--lint` / `--verify` /
      `--propose`; cache under `tools/audit-cache/`)
- [x] Phase 1 MOT corpus (`tools/audit-mots.json`: 35 real fleet PARTNOs from
      the QuickSet dumps + demo RDB, 12 synthesized; 15 legacy models have no
      decode at all to synthesize from — listed in the file)
- [x] Phase 2 audit run + triage report (`tools/audit-triage.md`; full
      configurator cache in `tools/audit-cache/`, 216 responses — verify
      re-runs offline). C: 15 models, B: 8 more, A-only: 9; clean: 7.
- [ ] Phase 3 fixes (order: hardcoded-source models first — 2731, 2740S, 2741,
      2742, 3350, 3355, 3360SE, 3505, 3555, 3560E, 3560S, 487B, 421, 849,
      734B, 787Z, 2488, 2664S — then census-severity order: 451, 421, 411L,
      710-5, 700G, 401, …). Done so far (see audit-triage.md for detail):
      651R and 751 FIXED with regression tests (751 exposed a new defect
      class — a combined-slot group reading only one of the two slots its
      layers are keyed on, now caught by `--lint` as under-conditioned-group);
      735 and 700G fixed; 2414's bad IM example annotated; 311C/3620 were
      corpus noise (wildcarded example MOTs, now reclassified); 351S and
      651RA legacy-unit codes documented per the honesty rule. 421 and 451
      FIXED with regression tests: decodePartNumber.js now supports
      length-keyed `part_number.submodels` tables (submodels of one product
      take differently-sized MOTs with the same field at different
      positions), `--propose` drafts one table per length, and both models
      were rebuilt on it — including 451's over-pinned drawing rules
      (fleet units with populated I/O boards fell through to the 3U
      drawing) and a layer-source sweep (451's front overlay read the
      mainboard-voltage digit: every 24 Vdc unit got the Bay Control
      overlay). 487E FIXED across all three of its ordering formats (modern
      23-char, when-conditioned legacy firmware-0/1, 25-char 487E-5 SV/TiDL);
      2411 and 710-5 drawing rules corrected (missing PDFs named: i7037f,
      i7355.B — dwgen asks for them). Verify now recognizes SEL's generic
      dimension sheets, so "SEL has no config drawing for this legacy
      config" reports as info, not a mismatch. Fetch session 2026-08-30
      (browser-driven, signed CDN URLs): 8 drawings fetched with DWGs —
      351R's four per-config drawings (SEL-351R submodel + rules landed;
      fleet units clean), 311L i3441b, 2411 i7037f, 710-5 i7355.B, 700G
      i7383.B, with layer rules generated from the PDFs' own catalogs. 2407
      fixed offline (drawings were already present; rules re-keyed on the
      mounting digit); 351RS re-grounded. Bucket C is down to 4 findings
      (551C/501/2730M have no drawing metadata at all; 587Z one rule gap);
      bucket B's 5 findings are all documented-intentional. Still open:
      the remaining from-scratch authoring gaps (551C, 501; 2730M DONE
      2026-08-30 — i7198f located manually in the CDN, full layer metadata
      + crops authored and regression-tested), the no-decode models,
      hardcoded-source cleanup on the remaining lint models. Crops for all
      8 fetched drawings drawn by hand (local crop tool, 2026-08-30) and
      verified by rendering front/rear previews from real fleet MOTs.
- [ ] Phase 4 lint-as-test
