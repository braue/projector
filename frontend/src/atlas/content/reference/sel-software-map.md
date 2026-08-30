---
title: SEL Software Map
summary: Which SEL software does what — settings, RTAC projects, event analysis, HMI, networking, synchrophasors, and the management tools around them.
tags: software,ACSELERATOR,QuickSet,SEL-5030,SEL-5033,SEL-5601,SEL-5056,Compass,Grid Configurator,Diagram Builder,TEAM,Blueframe
order: 50
---

# SEL Software Map

The tool you reach for depends on which layer you are working at. This page is the
index; each tool's workflow lives on the page linked from its row.

## Everyday tools

| Product | Name | What it does | Atlas page |
|---|---|---|---|
| **SEL-5030** | ACSELERATOR QuickSet | Relay settings, SELogic logic editing, HMI, phasor display, event retrieval, settings databases (`.rdb`), Design Templates | [Engineering Access & QuickSet](atlas:rtac-automation/quickset.html) |
| **SEL-5033** | ACSELERATOR RTAC | RTAC projects: device configuration, tag database, IEC 61131-3 logic, IO maps, HMI diagrams, users | [RTAC Platform](atlas:rtac-automation/rtac-platform.html) |
| **SEL-5601-2** | synchroWAVe Event | Opening and analyzing relay event reports and COMTRADE records — waveforms, phasors, harmonics, fault location | Event Analysis |
| **SEL Compass** | Compass | Finds, downloads, and manages SEL software and firmware, and keeps installed versions current | [Firmware Upgrades](atlas:relays-devices/firmware-upgrades.html) |
| **Diagram Builder** | (bundled with RTAC tooling) | Builds the RTAC's web HMI screens: draw, bind to tags, publish | [RTAC Web HMI](atlas:rtac-automation/rtac-hmi.html) |

## Settings, data, and fleet management

| Product | Name | What it does |
|---|---|---|
| **SEL-5045** | ACSELERATOR TEAM | Central database and management of settings and device data across a fleet, with an ACSELERATOR database behind it |
| **SEL-5037** | Grid Configurator | IEC 61850 system engineering — building and managing the SCL files (ICD → SCD → CID) that define a 61850 station |
| **SEL-5630** | ACSELERATOR Meter Reports | Retrieval and reporting for SEL meters — load profile, energy, power quality |
| **SEL-5231** | SEL Configuration API | Programmatic configuration, for automating what would otherwise be manual tool work |
| **Blueframe** | SEL Blueframe | Container-based application platform on SEL automation hardware, with device management and automation applications built on shared device data | [Substation Computers & Blueframe](atlas:rtac-automation/sel-computers.html) |

## Networking and security

| Product | Name | What it does | Atlas page |
|---|---|---|---|
| **SEL-5056** | Software-Defined Network Flow Controller | Designs, deploys, and monitors OT SDN flows on SEL-2740S switches; also exposes a REST API | [Software-Defined Networking](atlas:comms/sdn.html) |
| **SEL-5057** | Flow Auditor | Data collection supporting NERC CIP-007-6 R1.1 — auditing what is actually allowed to communicate | [Substation Cybersecurity](atlas:comms/cybersecurity.html) |
| **SEL-5815** | PRP Driver for Windows | Lets a Windows host participate in a PRP network | [PRP & HSR Redundancy](atlas:comms/prp-hsr-redundancy.html) |

## Synchrophasors

| Product | Name | What it does | Atlas page |
|---|---|---|---|
| **SEL-5073** | SYNCHROWAVE Phasor Data Concentrator | Software PDC — aggregates and time-aligns C37.118 streams | [Synchrophasors](atlas:data-protocols/synchrophasors.html) |
| **SEL-5078-2** | SYNCHROWAVE Central | Central synchrophasor application — visualization and analysis across the system | [Synchrophasors](atlas:data-protocols/synchrophasors.html) |
| **Synchrowave Operations / Monitoring** | Synchrowave platform applications | Operational synchrophasor monitoring and analytics | [Synchrophasors](atlas:data-protocols/synchrophasors.html) |

## Choosing the right tool

| I need to… | Use |
|---|---|
| Change a relay setting | QuickSet (SEL-5030) |
| Add a device to the RTAC | ACSELERATOR RTAC (SEL-5033) |
| Understand why a relay tripped | synchroWAVe Event (SEL-5601-2) |
| Build an operator screen | Diagram Builder |
| Find the right firmware version | Compass |
| Manage settings across many relays | ACSELERATOR TEAM (SEL-5045) |
| Engineer an IEC 61850 station | Grid Configurator (SEL-5037) |
| Configure an SDN network | SEL-5056 |
| Concentrate synchrophasor streams | SEL-5073 |
| Read a meter's load profile | ACSELERATOR Meter Reports (SEL-5630) |

## Practical notes

- **Driver and firmware matching.** QuickSet selects a settings driver from the relay's FID
  string. Update the driver before reading or writing settings on newly upgraded firmware,
  or the tool and the relay will disagree about which settings exist. See
  [Firmware Upgrades](atlas:relays-devices/firmware-upgrades.html).
- **Version compatibility on the RTAC.** The ACSELERATOR RTAC software version, the device
  firmware version, and the project's target version all have to agree. Check before
  upgrading anything.
- **Keep a text export beside every binary settings file.** Binary databases are readable
  only by a compatible tool version; a text export can be diffed, searched, and read in ten
  years. See [Settings Management](atlas:relays-devices/settings-management.html).
- **Not everything needs a tool.** SEL ASCII over a serial cable or Telnet reaches every
  command a relay has — `MET`, `TAR`, `SER`, `EVE`, `SHO`, `STA` — and it works when the
  GUI does not. See [The Field Kit](atlas:start-here/field-kit.html).

*Product names and functions are drawn from the SEL instruction manuals present in the
local reference library (SEL-5030 QuickSet, SEL-5033 ACSELERATOR RTAC, SEL-5037 Grid
Configurator, SEL-5045 ACSELERATOR TEAM, SEL-5056 SDN Flow Controller, SEL-5057 Flow
Auditor, SEL-5073 SYNCHROWAVE PDC, SEL-5078-2 SYNCHROWAVE Central, SEL-5231 Configuration
API, SEL-5601-2 synchroWAVe Event, SEL-5630 ACSELERATOR Meter Reports, SEL-5815 PRP Driver,
SEL Compass, Diagram Builder, and SEL Blueframe). SEL's software catalog changes; confirm
current availability and version before specifying.*
