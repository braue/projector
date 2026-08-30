---
title: ANSI Device Numbers
summary: The IEEE C37.2 device numbers you meet on SEL gear and on drawings, with suffixes, common combinations, and what each one means in the field.
tags: ANSI,C37.2,device numbers,protection,elements,50,51,87,suffixes,relay word
order: 20
---

# ANSI Device Numbers

IEEE C37.2 assigns a number to each protective and control function. Relay Word bits,
one-line diagrams, settings sheets, and SEL manuals all speak in these numbers — `51P` is
"phase time-overcurrent," not a model name.

## Suffix vocabulary

Suffixes narrow the operating quantity and the stage. They combine, and the order is
conventional rather than mandated.

| Suffix | Means | Example |
|---|---|---|
| **P** | Phase quantity | `51P` phase time-overcurrent |
| **G** | Ground — residual (3I<sub>0</sub>), calculated from the phase CTs | `51G` residual time-overcurrent |
| **N** | Neutral — measured by a dedicated neutral or window CT | `51N` neutral time-overcurrent |
| **Q** | Negative sequence | `50Q` negative-sequence instantaneous |
| **1, 2, 3…** | Level or zone number | `50P1`, `50P2`, `Z2` |
| **T** | Timed-out output (as opposed to the pickup bit) | `51PT` |
| **U / O** | Under / over | `27` is undervoltage, `59` overvoltage, `81U`/`81O` under/over frequency |
| **R** | Rate of change, or reverse | `81R` rate of change of frequency |
| **V** | Voltage-supervised | `51V` voltage-controlled or -restrained overcurrent |
| **BF** | Breaker failure | `50BF`, also written `50/62BF` |

**Reading a full element name.** `67G2T` unpacks as **67** directional overcurrent ·
**G** ground quantity · **2** level 2 · **T** timed-out (the delayed output, as opposed to
the instantaneous pickup bit). The exact bit vocabulary is model-specific — check the
Relay Word bit tables in that relay's instruction manual, and see
[Inside a Protective Relay](atlas:relays-devices/relay-anatomy.html).

## The ones you meet constantly

| No. | Function | Field meaning | Atlas page |
|-----|----------|----------|---|
| 21 | Distance | Impedance-based line protection; trips by "electrical distance" to the fault (zones) | [Distance Protection](atlas:protection/distance-21.html) |
| 24 | Volts per hertz | Overexcitation — core saturation, an inverse-time thermal characteristic | [Transformer Protection](atlas:protection/transformer-protection.html) |
| 25 | Synchronism check | Permits closing only when the two sides are close in voltage, angle, and slip | [Synchronism Check & Closing](atlas:protection/sync-check-closing.html) |
| 27 | Undervoltage | Picks up when voltage drops below setting | [Protection Elements](atlas:protection/protection-elements.html) |
| 32 | Directional power | Operates on real-power direction and magnitude — reverse power on a generator | [Generator Protection](atlas:protection/generator-protection.html) |
| 37 | Undercurrent / underpower | Load loss: lost coupling, dry pump, broken belt | [Motor Protection](atlas:protection/motor-protection.html) |
| 40 | Loss of field | Generator excitation lost; machine absorbs large reactive power | [Generator Protection](atlas:protection/generator-protection.html) |
| 46 | Negative-sequence overcurrent | Unbalance, broken conductor, single-phasing; rotor heating on machines | [Symmetrical Components](atlas:fundamentals/symmetrical-components.html) |
| 49 | Thermal | Thermal image of the protected equipment (motor, transformer, cable) | [Motor Protection](atlas:protection/motor-protection.html) |
| 50 | Instantaneous overcurrent | Trips with no intentional delay above pickup | [Protection Elements](atlas:protection/protection-elements.html) |
| 51 | Time-overcurrent | Inverse-time curve: higher current, faster trip | [Coordination & TCC](atlas:protection/coordination-tcc.html) |
| 52 | AC circuit breaker | The breaker itself; 52a/52b are auxiliary contacts following its position | [One-Lines & Schematics](atlas:fundamentals/one-line-diagrams.html) |
| 59 | Overvoltage | Picks up when voltage rises above setting | [Protection Elements](atlas:protection/protection-elements.html) |
| 60 | Voltage / current balance | Blown-fuse and loss-of-potential detection | [Protection Elements](atlas:protection/protection-elements.html) |
| 62 | Timer | Time-delay auxiliary within a scheme | |
| 63 | Pressure | Transformer sudden pressure / Buchholz | [Power Transformers](atlas:fundamentals/transformers.html) |
| 64 | Ground detector | 64G stator ground, 64F field ground | [Generator Protection](atlas:protection/generator-protection.html) |
| 67 | Directional overcurrent | 50/51 supervised by fault direction (forward / reverse) | [Protection Elements](atlas:protection/protection-elements.html) |
| 79 | Reclosing | Automatic reclose sequence: shots, open and reclaim intervals, lockout | [Reclosing (79)](atlas:protection/reclosing.html) |
| 81 | Frequency | Under/over frequency (81U/81O), rate of change (81R) — load shedding | [Frequency & Load Shedding](atlas:protection/frequency-load-shedding.html) |
| 86 | Lockout | Hand-reset master trip relay; blocks reclose and close until reset | [One-Lines & Schematics](atlas:fundamentals/one-line-diagrams.html) |
| 87 | Differential | Current in ≠ current out of a zone: 87T transformer, 87B bus, 87L line | [Differential (87)](atlas:protection/differential-87.html) |
| 89 | Disconnect switch | Not a load-break device; 89a/89b are its auxiliary contacts | [Bus Protection](atlas:protection/bus-protection-87b.html) |

## Seen less often, still worth recognizing

| No. | Function |
|-----|----------|
| 14 | Speed switch |
| 26 | Apparatus thermal device |
| 30 | Annunciator |
| 33 | Position switch |
| 36 | Polarity or polarizing voltage device |
| 43 | Manual transfer or selector device |
| 47 | Phase-sequence voltage (reversal or unbalance) |
| 48 | Incomplete sequence / locked rotor |
| 50BF | Breaker failure (also shown as 50/62BF) |
| 51V | Voltage-controlled or voltage-restrained time-overcurrent |
| 55 | Power factor |
| 65 | Governor |
| 66 | Starting-frequency limit (starts per hour) |
| 68 | Blocking / power-swing blocking |
| 69 | Permissive control device |
| 71 | Level switch (transformer oil level) |
| 74 | Alarm relay |
| 78 | Out of step / phase-angle measuring |
| 83 | Automatic selective control or transfer |
| 85 | Pilot / carrier-scheme communications |
| 90 | Regulating device (voltage regulator, load control) |
| 94 | Tripping / trip-free auxiliary |

## Common combinations on drawings

| Written as | Means |
|---|---|
| `50/51` | An instantaneous and a time-overcurrent element in one device |
| `50/51N` | The same, on the measured neutral quantity |
| `67N` | Directional neutral overcurrent |
| `27/59` | Under- and overvoltage in one device |
| `81U/81O` | Under- and over-frequency |
| `50/62BF` | Breaker failure: an overcurrent detector supervised by a timer |
| `87T`, `87B`, `87L`, `87Q` | Transformer, bus, line, and negative-sequence differential |
| `52a`, `52b` | Breaker auxiliary contacts: 52a follows the breaker, 52b opposes it |
| `86T`, `86B` | Transformer and bus lockout relays |
| `TC1`, `TC2` | First and second trip coils on a dual-trip breaker |

## Where the numbers come from and where they end up

- **On the one-line and three-line**, they identify what protects each piece of equipment.
- **In the relay**, they name Relay Word bits, and those bits are what
  [SELogic](atlas:relays-devices/selogic.html) equations are written in.
- **In the SER**, each bit transition is a logged row — see [SER & SOE](atlas:relays-devices/ser-soe.html).
- **In the points list**, they become the SCADA point names an operator reads.

Keeping the same number visible at every layer is what lets a person trace a trip from an
operator's alarm back to the element that caused it. Renaming it along the way — "Feeder 3
Overcurrent" in SCADA with no reference to `51P` — is a small convenience that costs a lot
during an investigation.
