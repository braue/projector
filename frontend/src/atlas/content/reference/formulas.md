---
title: Formulas & Quick Math
summary: The arithmetic you actually reach for in the field — three-phase power, per-unit, CT/PT scaling, fault current, curve equations, timing, and unit conversions.
tags: formulas,quick math,per-unit,three-phase,CTR,PTR,fault current,TCC,curve equation,cycles,dB,conversions
order: 30
---

# Formulas & Quick Math

Everything on this page is standard power-system arithmetic. The SEL-specific settings
that use these quantities are on the linked pages.

## Three-phase power

| Quantity | Balanced three-phase | Single phase |
|---|---|---|
| Apparent power S | √3 · V<sub>LL</sub> · I<sub>line</sub> | V · I |
| Real power P | √3 · V<sub>LL</sub> · I<sub>line</sub> · cos φ | V · I · cos φ |
| Reactive power Q | √3 · V<sub>LL</sub> · I<sub>line</sub> · sin φ | V · I · sin φ |
| Power factor | cos φ = P / S | |
| S from P and Q | S = √(P² + Q²) | |

**Handy forms**

- Line current from MVA: `I (A) = MVA × 1000 / (√3 × kV)`
- Line current from MW at a power factor: `I (A) = MW × 1000 / (√3 × kV × pf)`
- At 12.47 kV, 1 MVA ≈ **46.3 A**. At 13.8 kV, 1 MVA ≈ **41.8 A**. At 4.16 kV, 1 MVA ≈ **138.8 A**.
- At 115 kV, 1 MVA ≈ **5.02 A**. At 230 kV, 1 MVA ≈ **2.51 A**.

## Wye and delta

| | Wye | Delta |
|---|---|---|
| Line-to-line voltage | √3 × winding voltage | = winding voltage |
| Line current | = winding current | √3 × winding current |
| Zero-sequence path | out the neutral | circulates inside |

√3 = 1.7321 · 1/√3 = 0.5774 · √2 = 1.4142 · 1/√2 = 0.7071

## RMS, peak, and DC offset

- `V_rms = V_peak / √2` — a 120 V RMS PT secondary peaks at 169.7 V.
- DC offset time constant: `τ = X / (ω R) = (X/R) / 377` seconds at 60 Hz.
- Fully offset first peak can approach `2 × √2 × I_sym_rms` = **2.83 × I<sub>sym</sub>** on a
  very high X/R circuit.

## Per-unit

| Base quantity | Formula |
|---|---|
| Base current | I<sub>base</sub> = S<sub>base</sub> / (√3 · V<sub>base</sub>) |
| Base impedance | Z<sub>base</sub> = V<sub>base</sub>² / S<sub>base</sub> |
| Per-unit impedance | Z<sub>pu</sub> = Z<sub>actual</sub> / Z<sub>base</sub> |
| Rebasing | Z<sub>new</sub> = Z<sub>old</sub> · (S<sub>new</sub>/S<sub>old</sub>) · (V<sub>old</sub>/V<sub>new</sub>)² |

**Example** — 100 MVA base at 12.47 kV:
I<sub>base</sub> = 100 000 / (1.7321 × 12.47) = **4630 A**;
Z<sub>base</sub> = 12.47² / 100 = **1.555 Ω**.

## Fault current

| Case | Expression |
|---|---|
| Three-phase | I<sub>f</sub> = E / Z<sub>1</sub> |
| Line-to-line | I<sub>f</sub> = √3 · E / (Z<sub>1</sub> + Z<sub>2</sub>) ≈ 0.866 × three-phase when Z<sub>1</sub> = Z<sub>2</sub> |
| Line-to-ground | 3I<sub>0</sub> = 3E / (Z<sub>1</sub> + Z<sub>2</sub> + Z<sub>0</sub>) |
| Through a transformer | I<sub>f</sub> ≈ I<sub>rated</sub> / Z<sub>pu</sub> (ignoring source impedance) |

An 8% transformer passes about **12.5 × rated current** into a bolted secondary fault
before source impedance is added. See [Faults & Fault Current](atlas:fundamentals/faults-and-fault-current.html).

## Symmetrical components

With **a = 1∠120°**:

| Component | From phase quantities |
|---|---|
| Positive | I<sub>1</sub> = ⅓(I<sub>A</sub> + a·I<sub>B</sub> + a²·I<sub>C</sub>) |
| Negative | I<sub>2</sub> = ⅓(I<sub>A</sub> + a²·I<sub>B</sub> + a·I<sub>C</sub>) |
| Zero | I<sub>0</sub> = ⅓(I<sub>A</sub> + I<sub>B</sub> + I<sub>C</sub>) |
| Back to phase A | I<sub>A</sub> = I<sub>0</sub> + I<sub>1</sub> + I<sub>2</sub> |

Relays publish **3I<sub>0</sub>** (the residual, equal to I<sub>A</sub>+I<sub>B</sub>+I<sub>C</sub>)
and **3I<sub>2</sub>**. A study reporting I<sub>0</sub> is reporting one third of what the
relay setting expects — see [Symmetrical Components](atlas:fundamentals/symmetrical-components.html).

## Fault-type fingerprints

| Fault | I<sub>1</sub> | I<sub>2</sub> | I<sub>0</sub> |
|---|---|---|---|
| Three-phase | large | ~0 | ~0 |
| Line-to-line | large | ≈ I<sub>1</sub> (opposite) | ~0 |
| Line-to-ground | present | ≈ I<sub>1</sub> | ≈ I<sub>1</sub> |
| Line-to-line-to-ground | present | present | present |

## CT and PT scaling

- `Secondary amps = Primary amps / CTR`, where CTR = ratio (e.g. 600:5 → CTR = 120).
- `Primary amps = Secondary amps × CTR`.
- `Secondary volts = Primary volts / PTR`.
- **Burden:** total Ω (or VA at rated secondary current) seen by the CT — leads plus device.
  Round-trip lead resistance matters: two conductors, so use twice the one-way length.
- A C-class rating (e.g. **C400**) means the CT delivers 20 × rated secondary current into
  the stated standard burden with ≤ 10% ratio error. C400 → 400 V at the terminals, i.e.
  100 A into 4 Ω. See [CT & PT Fundamentals](atlas:fundamentals/ct-pt-fundamentals.html).

## Time-overcurrent curve equation

The standard inverse-time form used by SEL relays:

```
t = TD × ( A / (M^p − 1) + B )
```

where **M** = multiple of pickup (I / I<sub>pickup</sub>), **TD** = time dial, and A, B, p
come from the selected curve (U1–U5 US curves, C1–C5 IEC curves). Reset characteristics
have their own equation for electromechanical-emulation reset.

- Doubling the time dial doubles the operating time at every current.
- The curve is only defined **above** pickup; at M ≤ 1 the element does not operate.
- Coordination time interval (CTI) between two curves is typically **0.2–0.4 s** at the
  maximum current both devices see. See [Coordination & TCC Curves](atlas:protection/coordination-tcc.html).

## Timing

| Conversion | 60 Hz | 50 Hz |
|---|---|---|
| One cycle | 16.667 ms | 20 ms |
| One quarter cycle | 4.17 ms | 5 ms |
| 1 ms | 0.06 cycle | 0.05 cycle |
| 1 electrical degree | 46.3 µs | 55.6 µs |
| Typical breaker clearing | 3–5 cycles = 50–83 ms | 3–5 cycles = 60–100 ms |

**Why one degree matters:** in a line differential scheme, 46 µs of channel asymmetry is one
degree of false differential angle. See [Line Current Differential](atlas:protection/line-differential-87l.html).

## Impedance and distance

- Line impedance in secondary ohms: `Z_sec = Z_pri × (CTR / PTR)`.
- Distance reach in per-unit of line length: `reach = Z_set / Z_line`.
- Zone 1 is conventionally set to **80–90%** of the line, Zone 2 to **120–150%**.
- Fault angle ≈ arctan(X/R). Load sits near ±15–30°; faults at 60–85°.

## Voltage drop

- Single phase: `V_drop = 2 × I × L × R_per_unit_length` (out and back).
- Three phase: `V_drop = √3 × I × L × (R cos φ + X sin φ)`.
- **Percent regulation:** `(V_noload − V_load) / V_load × 100`.
- On a DC trip circuit, size for the coil pulse at **end-of-discharge** battery voltage,
  not at float. See [Station DC Systems](atlas:fundamentals/dc-systems.html).

## Capacitors

- `Q (kVAr) = V² / X_C` — a bank's output scales with the **square** of voltage, so a bank
  installed to raise voltage produces less than nameplate when voltage is low.
- IEEE continuous limits: **110%** rated RMS voltage, **180%** rated RMS current,
  **135%** rated reactive power. See [Capacitor Banks & Control](atlas:distribution-equipment/capacitor-control.html).

## Decibels and optical budgets

- `dB = 10 log₁₀(P₂/P₁)` for power. **3 dB = half**, **10 dB = one tenth**.
- dBm is power referenced to 1 mW: `0 dBm = 1 mW`, `−30 dBm = 1 µW`.
- Link margin = TX power (dBm) − path/fiber loss (dB) − connector and splice losses (dB)
  − RX sensitivity (dBm). Keep margin for ageing, dirt, and repairs.
- Received power must also stay **below** the receiver's maximum, or a long-haul optic on a
  short jumper overdrives the far end. See [Fiber & SFPs](atlas:comms/fiber-sfps.html).

## Serial framing

- Bits per character = 1 start + data bits + parity (0 or 1) + stop bits.
  8N1 = **10 bits per byte**; 8E1 or 7E1 with two stop bits = 11.
- `Characters per second ≈ baud / bits-per-character`. At 9600 baud, 8N1 → **960 bytes/s**.
- A 100-byte DNP3 frame at 9600 baud takes about **104 ms** on the wire — before the
  outstation has thought about it. See [Serial Comms](atlas:comms/serial-comms.html).

## Units and constants

| | |
|---|---|
| ω at 60 Hz | 377 rad/s |
| ω at 50 Hz | 314 rad/s |
| 1 mile | 1.609 km |
| 1 foot | 0.3048 m |
| 1 inch | 25.4 mm |
| °C → °F | °F = °C × 9/5 + 32 |
| 1 kcmil | 0.5067 mm² |
| Copper resistivity at 20 °C | ≈ 10.37 Ω·cmil/ft |
| 1 pu on 100 MVA at 12.47 kV | 4630 A · 1.555 Ω |

## Sanity checks worth memorizing

- **A number off by 1.73 or 0.577** is a wye/delta assumption, not a CT problem.
- **A number off by exactly 10, 100, or 1000** is scaling applied twice.
- **A number off by the CT ratio** is `CTR` set wrong, or a multi-ratio CT on the wrong tap.
- **A large residual on balanced load** means a CT wiring error or a shorting screw left in.
- **Ground fault current far above the three-phase value** is legitimate when Z<sub>0</sub> < Z<sub>1</sub>
  — check the study rather than assuming an error.
