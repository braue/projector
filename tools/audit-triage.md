# Drawing-metadata audit — Phase 2 triage report (2026-08-30)

Produced by `tools/audit-sel-metadata.mjs --verify` over the Phase 1 corpus
(206 MOTs: metadata examples, dwg-sources lookup PNs, 35 real fleet PARTNOs,
12 synthesized). Every configurator response is cached under `tools/audit-cache/`,
so `--verify --offline` reproduces all of this without network.

Buckets, worst first: **C** — we select a different PDF than the configurator
lists; **B** — right drawing, but a layer group fails to resolve (missing or
wrong layers); **A** — decode-only gaps ("(unrecognized)" rows in the UI).

**Caveat on C:** the configurator's drawing set mixes configuration drawings
with generic dimension/mounting sheets. The harness now recognizes the
generics (drawing numbers appearing across 3+ models, plus 000/-foldered
i9xxx per-model dimension sheets) and excludes them from the reference set;
a configuration with ONLY generic sheets reports as info-grade
`no-config-drawing` instead of a mismatch. Legacy models (351, 2407) get
per-configuration static drawings from SEL where our corpus uses one layered
master — those Cs need the legacy drawings fetched.

## C — drawing-selection mismatches (15 models)

### 2407
- front: we select i3858b.pdf, configurator lists {i9152, i4723, i3857}   _[240700003, 240700013, 240700033]_
- front: we select i3858b.pdf, configurator lists {i9038, i4724, i3857}   _[24070000W]_
- drawings: no matching or unconditional front/rear drawing for this model; using the first rule as a fallback   _[240700013, 240700033, 24070003B…]_
- front: we select i3858b.pdf, configurator lists {i9035, i4725, i3857}   _[24070003B, 24070011B]_

### 2411 — FIXED 2026-08-30
- Chassis code '2' at position 5 (Vertical Panel Mount, Large LCD) is drawn by
  i7037, not the i7036 base drawing — a position-5 rule now names i7037f.pdf
  (not yet in the corpus, CDN 20-2240/i7037f.pdf; dwgen asks for it by name).
### 2730M — FIXED 2026-08-30 (regression test in tools-dwgen.test.js)
- Master configuration drawing i7198f located by hand in CDN folder 23-1023
  (the configurator does not serve the 2730M) and fetched with its DWG. Layer
  rules generated from its own catalog; the drawing's digit template CONFIRMS
  the WI-9662 column-aligned decode positions exactly, upgrading the table
  from "no drawing to calibrate against". SFP codes (AAAA/CCCC) filled from
  the catalog; crops placed from the sheet's ink bounds and verified by
  rendering a fully-optioned configuration — every layer group resolves.
### 300G
- drawings: no matching or unconditional front drawing for this model; using the first rule as a fallback   _[0300GXXXXXXXXXXXX]_
- drawings: no matching or unconditional rear drawing for this model; using the first rule as a fallback   _[0300GXXXXXXXXXXXX]_

### 311L
- rear: we select i3442b.pdf, configurator lists {i9057, i3436, i3441}   _[0311L0HDD4254XX]_

### 351 / SEL-351R — FIXED 2026-08-30 (fetch session)
- The 0351R fleet units are SEL-351R Recloser Controls sharing the 0351 prefix.
  Their four per-configuration drawings (i3523a/i3097a fronts, i3096b/i3468b
  rears) were fetched into the corpus with DWGs, a `when`-conditioned 351R
  submodel decode table was built from the configurator decodes of the fleet
  units, and R-gated drawing rules select front by User Interface (position 13)
  and rear by Communications Port (position 11). The 500+-sighting fleet units
  verify clean; the firmware-4 variants (configurator-refused) are documented.
### 351RS — FIXED 2026-08-30
- Decode table re-grounded verbatim from the configurator (10 positions);
  comms code 'A' (One 10/100BASE-T) gets an EXPLICIT rear rule to i4868b —
  SEL lists no drawing for it; the choice is a documented approximation
  rather than a silent first-rule fallback. 4/4 corpus MOTs clean.
### 352
- drawings: no matching or unconditional front drawing for this model; using the first rule as a fallback   _[0352XXXXXXXXXXX]_

### 451 — FIXED 2026-08-30 (regression test in tools-dwgen.test.js)
- 21-character SEL-451-5 decode table landed as `part_number.submodels` (the
  submodel-aware decode unblock), configurator-grounded incl. a real fleet unit.
- Drawing rules for the 21-character format rewritten from over-pinned example
  MOTs to mounting+chassis position conditions — fleet units with populated I/O
  boards used to fall through to the 3U drawing.
- Layer-source sweep against the verified table: connector+voltage composite
  read 6&8 (power supply & current) → 7&9; Ethernet read 9 or 12 → 11; front
  overlay read 13 (mainboard voltage — every 24 Vdc unit got the Bay Control
  overlay) → 21; 3U chassis marker 13 → 15. 24+8 group fixes across ten PDFs.
- Decode enriched from the layer catalogs (panel mounts, Bay Control overlay,
  Ethernet cards 1/2/3/5, I/O cards 1-8/A/B). 10/10 verifiable MOTs clean,
  0 lint defects.
### 487E — FIXED 2026-08-30 (regression test extended)
- THREE ordering formats now decoded: the modern 23-character table (default),
  a `when`-conditioned legacy submodel (firmware 0/1 — same length, position 6
  alone is the firmware, 11-15 hold different fields; decodeWithMetadata now
  supports `when` conditions on submodels for exactly this case), and the
  25-character 487E-5 Sampled Values / TiDL table.
- Layer fixes: legacy firmware combo "0-1" maps to an empty layer list (no
  legacy label layer in the i7082.K catalog); board D&E code '0' = Empty on
  i7293.B. Modern table enriched from configurator decodes (mainboard 24 Vdc,
  5U/9U chassis, 1A/5A AC card 2 variants, empty D&E).
- 11/14 corpus MOTs clean; the rest are honest info findings (legacy configs
  for which SEL has only the i9164 dimension sheet, one refused legacy PN).
### 501
- Missing front/rear drawing metadata for 501   _[0501XXXXXXXXXX]_

### 551C
- Missing front/rear drawing metadata for 551C   _[0551C0BX5X1X]_

### 587Z
- drawings: no matching or unconditional front/rear drawing for this model; using the first rule as a fallback   _[0587ZXXXX5XX2XX]_

### 700G — FIXED 2026-08-30
- The mismatching MOT is a 700GW wind-generator dual-feeder unit; the configurator
  lists drawing i7383.B for it (not in the corpus). A drawing rule now names
  i7383.B.pdf explicitly, so dwgen asks for the missing PDF by name instead of
  silently rendering the generic i7379.B. Fetch i7383.B (CDN 24-5210/i7383.B.pdf)
  to finish. GROUP_2/SLOT_Z warnings disappeared with the correct drawing choice.
### 710-5 — FIXED 2026-08-30
- Front-panel code '1' split out of the i7354 rule to i7355.B (configurator-
  verified; matches the i7346/47/48 panel-code triple). i7355.B.pdf not yet in
  the corpus (CDN 24-5210/i7355.B.pdf); dwgen asks for it by name.
## B — layer defects, drawing correct (8 models)

### 2414 — example annotated 2026-08-30
- The failing MOT is the metadata's own "Real PN (IM)" example 2414A1A009X74151140,
  which the configurator rejects (invalid digits in positions 8, 9, 14, 15) and whose
  slot Z digits contradict its own note - mistranscribed from the IM figure.
  Annotated in the metadata; not a resolver defect.
### 311C — cleared (corpus noise)
- The unresolved groups fired only because the drawing-rule example MOTs are
  wildcarded (X) at the source positions. The harness now classifies these as
  "unspecified in this MOT", bucket A. No metadata defect.
### 351S — documented 2026-08-30 (honesty rule)
- The two failing MOTs (45 fleet sightings) are legacy units the configurator
  refuses; position 7 '1'/'3' and position 11 '5' noted as observed-but-undocumented.
  The other five corpus MOTs verify clean.
### 3620 — cleared (corpus noise)
- Same wildcarded-MOT pattern as 311C; reclassified by the harness.
### 651R — FIXED 2026-08-30 (exemplar; regression test in tools-dwgen.test.js)
- ~~drawings: unresolved layer option 651R:i7171.e.pdf:GROUP_3~~ — comms code
  'A' added to position 14 and mapped to an empty layer list (the built-in
  port draws nothing); accessories 'DC'/'DF' added to position 19; fleet code
  'V' at position 8 noted as undocumented (configurator refuses the PN).
  8 of 9 corpus MOTs verify clean; the ninth keeps its honest gap.

### 651RA — documented 2026-08-30 (honesty rule)
- The two failing MOTs (5 fleet sightings) are legacy SEL-651R-0-format units the
  configurator refuses. Codes '2' (position 13) and 'A' (position 14) are noted as
  observed-but-undocumented in the metadata; the layer group intentionally stays
  unresolved for them. The other 8 corpus MOTs (3,078 sightings) verify clean.
### 735 — FIXED 2026-08-30
- Position 12 'B' = no Ethernet card (configurator-decoded on the fleet meter):
  mapped to an empty layer list in all six PDFs' GROUP_2. Verifies clean.
### 751 — FIXED 2026-08-30 (regression test in tools-dwgen.test.js)
- SLOT_D '9' (RTD card, configurator-decoded) draws via the combined group; '9-'
  now maps to an empty standalone list.
- Position 5 language-variant codes (S, K-V) mapped to their English twins' extended-I/O
  layers per the decode table ('S' confirmed by configurator).
- NEW DEFECT CLASS FOUND: the COMBINED_SLOT_D_OPTION_9_&_SLOT_E groups read only
  slot E, so ANY 751 with a populated slot E silently got an RTD overlay layer.
  Rebuilt as slot-D+slot-E parts composites (751A's i7008 pattern). `--lint` now
  catches this class (under-conditioned-group).
## A — decode-only gaps (9 models with no worse finding)

### 2440 (2 distinct gaps)
- position 13 (comm_option_13): code "1" unrecognized — configurator says "Serial Port 2" = "EIA-232"
- position 13 (comm_option_13): code "4" unrecognized — configurator says "Serial Port 2" = "ST, 62.5 µm Multimode Fiber"

### 351A (1 distinct gaps)
- position 6 (firmware): code "1" unrecognized — configurator says "Firmware" = "Non-Directional, Three-Voltage"

### 401 (1 distinct gaps)
- position 10 (ethernet_connection): code "4" unrecognized — configurator says "Power Supply" = "48-125 Vdc or 110-120 Vac"

### 411L (1 distinct gaps)
- position 17 (chassis): code "7" unrecognized — configurator says "Chassis" = "7U, Up to Four I/O Boards"

### 421 — FIXED 2026-08-30 (regression test in tools-dwgen.test.js)
- 21-character SEL-421-4/-5 decode table landed as `part_number.submodels`;
  the top-level table stays the 25-character 421-7 format.
- Old-drawing layer sources corrected against it: connector group read the
  power-supply digit (a 24-48 Vdc unit got the Connectorized Relay layer) → 7;
  Ethernet group 9 → 11; the hardcoded empty-I/O-board groups now read the
  board digits at 16/18. Decode enriched from the layer catalogs.
  12/12 corpus MOTs clean, 0 lint defects.
### 487V (3 distinct gaps)
- position 12 (reserved_12): code "1" unrecognized
- position 15 (reserved_15): code "B" unrecognized
- position 16 (mainboard_input_voltage): code "A" unrecognized

### 587 (1 distinct gaps)
- position 6 (connection_type_conformal_coat): code "0" unrecognized — configurator says "Conformal Coat" = "No"

### 787 (35 distinct gaps)
- position 5 (firmware): code "2" unrecognized — configurator says "Model Options" = "Two-Winding Current Differential"
- position 7 (power_supply_slot_a): code "E1" unrecognized — configurator says "User Interface" = "English"
- position 11 (slot_d): code "X0" unrecognized — configurator says "Slot D" = "Empty"
- position 13 (slot_e): code "X0" unrecognized — configurator says "Slot E" = "Empty"
- position 15 (slot_z_current_input): code "X8" unrecognized — configurator says "Slot Z Current Inputs" = "6-Phase AC Current Input (1 Amp Winding 1/1 Amp Winding 2) (SELECT 6 ACI)"
- position 17 (processor_board_slot_b): code "1" unrecognized — configurator says "Slot Z Current Inputs" = "6-Phase AC Current Input (1 Amp Winding 1/1 Amp Winding 2) (SELECT 6 ACI)"
- … 29 more: `node tools/audit-sel-metadata.mjs --verify --offline --model 787 --verbose`

### T401L (8 distinct gaps)
- configurator decodes position 7 ("AC Current Inputs | Power Supply" = "5 A | 125-250 Vdc, 110-240 Vac"), which our table does not describe
- configurator decodes position 8 ("AC Current Inputs | Power Supply" = "5 A | 125-250 Vdc, 110-240 Vac"), which our table does not describe
- configurator decodes position 9 ("AC Current Inputs | Power Supply" = "5 A | 125-250 Vdc, 110-240 Vac"), which our table does not describe
- configurator decodes position 10 ("AC Current Inputs | Power Supply" = "5 A | 125-250 Vdc, 110-240 Vac"), which our table does not describe
- configurator decodes position 7 ("Contact Input Rated Voltage" = "125 Vdc"), which our table does not describe
- configurator decodes position 8 ("Contact Input Rated Voltage" = "125 Vdc"), which our table does not describe
- … 2 more: `node tools/audit-sel-metadata.mjs --verify --offline --model T401L --verbose`

## Clean (7 models)

2488, 2664S, 751A, 787Z, 849, 851, TWFL — every corpus MOT decodes fully, selects a PDF the
configurator lists, and resolves all layer groups.

## Unverifiable via configurator (8 models)

2431, 2725, 400G, 487B, 551, 700BT, 734B, 787L — legacy/non-configurator products or rejected part
numbers. Their audit rests on `--lint` alone; the 15 models with no decode
table at all are listed in `tools/audit-mots.json`.

## Suggested Phase 3 order

1. The 18 hardcoded-source models from `--lint` (start with those also in
   bucket B/C here: 421, 487B, 2488†, 734B, 787Z† — † lint-only, verify clean).
2. Bucket C models with real fleet units behind them: 351 (0351R fleet,
   1 043 units seen), 451, 2411, 700G, 710-5, 311L, 487E legacy PNs.
3. Bucket B models with fleet units: 651R, 651RA, 751, 351S, 735, 311C, 2414.
4. Bucket A decode gaps. 421 and 451: DONE 2026-08-30 — `decodePartNumber.js`
   now supports length-keyed `part_number.submodels` tables, and both models
   were rebuilt on it (see their sections). `--propose` groups cached decodes
   by part-number length to draft such tables.
5. The 15 no-decode legacy models — authoring work from SEL ordering sheets.
