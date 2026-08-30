---
title: Standards Map
summary: Which standard governs which part of the job — IEEE, IEC, ANSI, NERC — and what each one actually tells you.
tags: standards,IEEE,IEC,ANSI,NERC CIP,C37,61850,1815,62439,C57,80,485
order: 60
---

# Standards Map

You rarely read a standard cover to cover. You look one up because a decision needs a
defensible basis. This page tells you which one to look up.

## Protection and control

| Standard | Covers | Where it shows up |
|---|---|---|
| **IEEE C37.2** | Device function numbers and contact designations | Every 50, 51, 87, 52a on every drawing — see [ANSI Device Numbers](atlas:reference/ansi-device-numbers.md) |
| **IEEE C37.90 family** | Relay ratings, surge withstand, and test requirements | Relay specifications and type-test claims |
| **IEEE C37.91** | Transformer protection guide | [Transformer Protection](atlas:protection/transformer-protection.html) |
| **IEEE C37.102** | Generator protection guide | [Generator Protection](atlas:protection/generator-protection.html) |
| **IEEE C37.99** | Shunt capacitor bank protection guide | [Capacitor Banks & Control](atlas:distribution-equipment/capacitor-control.html) |
| **IEEE C37.104** | Automatic reclosing on AC distribution and transmission lines | [Reclosing (79)](atlas:protection/reclosing.html) |
| **IEEE C37.010 / C37.04** | Circuit breaker application and ratings | Interrupting duty, momentary ratings — see [Faults & Fault Current](atlas:fundamentals/faults-and-fault-current.html) |
| **IEEE 242 (Buff Book)** | Protection and coordination of industrial and commercial power systems | Coordination studies |
| **IEEE 399 (Brown Book)** | Power system analysis | Short-circuit and load-flow study practice |

## Instrument transformers and equipment

| Standard | Covers | Where it shows up |
|---|---|---|
| **IEEE C57.13** | Instrument transformer requirements — accuracy classes, burdens | C400 ratings, burden calculations — see [CT & PT Fundamentals](atlas:fundamentals/ct-pt-fundamentals.html) |
| **IEEE C57.13.3** | Grounding of instrument transformer secondary circuits | One ground per CT circuit — see [Control Wiring](atlas:fundamentals/control-wiring.html) |
| **IEEE C57.12 family** | Power transformer requirements | Nameplate conventions, vector groups — see [Power Transformers](atlas:fundamentals/transformers.html) |
| **IEEE C57.91** | Loading guide for mineral-oil-immersed transformers | Hot-spot temperature and permissible overload |
| **IEEE C57.104** | Dissolved gas analysis interpretation | Transformer DGA trending |
| **IEEE 18 / C37.99** | Shunt capacitor ratings and protection | The 110% / 180% / 135% continuous limits |

## Grounding and safety

| Standard | Covers | Where it shows up |
|---|---|---|
| **IEEE 80** | Substation grounding safety — step and touch potential, ground grid design | [Substation Anatomy](atlas:fundamentals/substation-anatomy.html) |
| **IEEE C62.92** | Neutral grounding of electric utility systems | Effectively-grounded criteria — see [System Grounding](atlas:fundamentals/grounding-systems.html) |
| **IEEE C37.101** | Generator ground protection | Stator ground schemes |
| **IEEE 1584** | Arc-flash hazard calculation | Incident energy, boundaries, labels — see [Arc-Flash Detection](atlas:protection/arc-flash-detection.html) |
| **NFPA 70E** | Electrical safety in the workplace (US) | PPE, approach boundaries, energized-work justification — see [Safety Practices](atlas:commissioning/safety-practices.html) |
| **IEEE 525** | Design and installation of cable systems in substations | Routing, separation, shielding |

## Station DC

| Standard | Covers |
|---|---|
| **IEEE 485** | Sizing lead-acid batteries for stationary applications — the duty-cycle method |
| **IEEE 450** | Maintenance, testing, and replacement of vented lead-acid batteries — including capacity testing |
| **IEEE 1188** | The same, for valve-regulated lead-acid (VRLA) batteries |
| **IEEE 1375** | Protection of DC power systems |

See [Station DC Systems](atlas:fundamentals/dc-systems.html).

## Communications and protocols

| Standard | Covers | Atlas page |
|---|---|---|
| **IEEE 1815** | DNP3 | [DNP3 Fundamentals](atlas:data-protocols/dnp3/fundamentals.html) |
| **IEC 61850** | Substation automation: data model, MMS, GOOSE, Sampled Values, SCL | [IEC 61850 & GOOSE](atlas:data-protocols/iec61850-goose.html) |
| **IEEE C37.118** | Synchrophasor measurement and data transfer | [Synchrophasors](atlas:data-protocols/synchrophasors.html) |
| **IEC 60870-5-101 / -104** | Telecontrol protocols (common outside North America) | [Choosing a Protocol](atlas:data-protocols/protocol-chooser.html) |
| **Modbus specification** | An open de facto standard, published by the Modbus Organization rather than a formal SDO | [Modbus Fundamentals](atlas:data-protocols/modbus/fundamentals.html) |
| **IEC 62439-3** | PRP and HSR network redundancy | [PRP & HSR Redundancy](atlas:comms/prp-hsr-redundancy.html) |
| **IEEE 802.1Q** | VLANs and priority tagging | [VLANs](atlas:comms/vlans.html) |
| **IEEE 802.1D / 802.1w** | Spanning tree and rapid spanning tree | [RSTP & Topologies](atlas:comms/rstp-topologies.html) |
| **IEEE C37.94** | Optical interface between teleprotection equipment and multiplexers | [Line Current Differential](atlas:protection/line-differential-87l.html) |
| **IEEE 1588 (PTP)** | Precision time protocol | [Time Synchronization](atlas:comms/time-sync.html) |
| **IRIG-B (IRIG 200)** | Serial time code | [Time Synchronization](atlas:comms/time-sync.html) |
| **IEEE C37.111 (COMTRADE)** | Common format for transient data exchange | [Event Reports & Oscillography](atlas:relays-devices/oscillography.html) |
| **IEEE C37.232 (COMNAME)** | Naming convention for time-sequence data files | Event file naming |
| **EIA/TIA-232, -485, -422** | Serial electrical interfaces | [Serial Comms](atlas:comms/serial-comms.html) |

## Cybersecurity and compliance

| Standard | Covers | Notes |
|---|---|---|
| **NERC CIP** | Reliability standards for bulk electric system cyber assets | Applies to registered entities and to assets meeting the impact criteria. Drives account management, patching, logging, and change control — see [Substation Cybersecurity](atlas:comms/cybersecurity.html) |
| **IEC 62443** | Industrial automation and control system security | Zones and conduits, security levels; increasingly referenced in specifications |
| **IEEE 1686** | Substation IED cybersecurity capabilities | What a relay must support: accounts, roles, logging |
| **NIST SP 800-82** | Guide to operational technology security | Practical guidance, widely referenced |

## Interconnection

| Standard | Covers | Atlas page |
|---|---|---|
| **IEEE 1547** | Interconnection and interoperability of distributed energy resources with associated interfaces | [DER Interconnection](atlas:distribution-equipment/der-interconnection.html) |
| **UL 1741** | Inverter, converter, and interconnection equipment certification | The certification path most inverters take |

Ride-through and trip requirements have been revised substantially over the life of these
standards, and jurisdictions adopt revisions on their own schedules. **Always work from
the interconnection agreement for the specific installation**, not from a remembered
version of the standard.

## How to use this page

1. **Find the decision you are defending** — a setting, a rating, a design choice.
2. **Look up the standard that governs it** and read the relevant clause, not a summary.
3. **Record the reference in the settings basis or design document.** A number with a
   citation survives review; a number without one gets changed by the next person.
4. **Check the edition.** Standards are revised, and the applicable edition may be the one
   in force when the equipment was installed rather than the current one.
5. **Remember that the utility's own standard usually governs** where it is stricter than
   the industry standard. Both are binding; the stricter one wins.

*This map lists the standards most often reached for in substation protection and
automation work. It is a routing table, not a substitute for the standards themselves,
and it does not attempt to reproduce their requirements.*
