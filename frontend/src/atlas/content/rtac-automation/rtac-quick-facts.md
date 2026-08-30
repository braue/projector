---
title: RTAC Quick Facts
summary: The non-obvious RTAC behaviors worth remembering — controls, tags, networking, servers, logic, and projects — collected from project work.
tags: RTAC,5033,tags,oper,pulseConfig,quick facts,gotchas,quality,PRP,servers
order: 100
---

# RTAC Quick Facts

The things that are true, matter, and are easy to forget. Each has a page behind it.

## Control tags

- Every DNP binary output is one base point with six members: `.status` (SPS) plus five
  verb structures (`operPulse`, `operLatchOn`, `operLatchOff`, `operTrip`, `operClose`).
- **Verbs fire on the rising edge of `ctlVal`** — one scan of TRUE sends one control.
  Holding it high sends nothing more and only blocks re-arming.
- **A failed control never retries itself.** Check the outcome and re-issue with a fresh edge.
- Per-verb settings columns (*Number of Pulses*, *On/Off Pulse Duration* — default
  1 / 2000 ms / 2000 ms) initialize the tag's `pulseConfig`; logic can overwrite it at runtime.
- **RTAC and Axion contact outputs execute `pulseConfig` for real**, quantized up to the RTE
  cycle. `PulseDecoder` gives the same behavior to any BOOL.
- Asserting two verbs in the same scan is **two separate controls**, not one merged one.
- Any verb is live on every RTAC point — the RTAC does not enforce a control model.
  The outstation at the far end decides what it accepts.

→ [DNP3 on the RTAC](atlas:data-protocols/dnp3/on-the-rtac.html) · [DNP3 Control Models](atlas:data-protocols/dnp3/controls.html)

## Tags and quality

- Quality travels with the value. A value whose quality says stale or invalid is not a
  value you should display as good — and it is the RTAC's job to carry that through.
- **Timestamps come from the source where the protocol carries them.** Modbus does not, so
  those tags carry scan time.
- The **Tag Processor is what moves data**. Nothing flows from a client tag to a server map
  by itself.
- Tag names outlive devices. Name by function, not by index or by which port it happens to
  be on.

→ [RTAC Tags & Quality](atlas:rtac-automation/rtac-tags.html) · [SCADA Integration](atlas:rtac-automation/scada-integration.html)

## Networking

- **Each NIC gets its own subnet.** Two NICs on the same subnet — with one unplugged —
  silently swallow traffic, because either interface is a "valid" path.
- Exactly one gateway is flagged **Primary** — the router used for RTAC-initiated
  off-subnet traffic. Incoming off-subnet traffic still needs that interface's gateway for
  the replies.
- **Per-NIC enables** (ping / web / database / EtherCAT) make healthy interfaces look dead.
  Check settings before pulling cables.
- **PRP pairs:** up to five (R147+); incompatible with DHCP, bridging, bonding, and
  EtherCAT on that NIC. Both LANs must be fully independent.
- A PRP **LAN ID Error** means A-tagged frames are arriving on the B port or vice versa —
  the two LANs are cross-connected somewhere.

→ [Ethernet & IP Addressing](atlas:comms/ethernet-ip.html) · [PRP & HSR Redundancy](atlas:comms/prp-hsr-redundancy.html)

## Servers

- Each DNP server device keeps **its own event queue**, even on a shared map. One master
  reading events does not consume another's.
- Server event buffers **default to one entry per tag** — latest value only. Configure SOE
  mode for real history, and size the buffer for the poll interval.
- **Do not map the same server point index twice** — duplicate indices do not generate events.
- A point with **event class None** never reports spontaneously. It looks fine during
  testing and lags in service.
- Ethernet servers either allow anonymous clients or enforce a client-IP allowlist. Both
  ends filter by address, so "no comms" can be an allowlist, not a route.

→ [DNP3 on the RTAC](atlas:data-protocols/dnp3/on-the-rtac.html)

## Logic

- Logic runs on a **task cycle**. Anything that must act faster than that cycle does not
  belong in the RTAC — it belongs in the relay.
- Contact-output pulse timing is **quantized up to RTE-cycle multiples**: a 97 ms request on
  a 100 ms task becomes 100 ms.
- Structured Text is the practical language; keep it readable, because the person
  debugging it at 3 a.m. may not be you.
- A settings or project change **restarts things**. Know what stops during a send, and for
  how long.

→ [IEC 61131-3 Logic on the RTAC](atlas:rtac-automation/rtac-logic.html)

## Projects and lifecycle

- The **software version, the firmware version, and the project's target version** all have
  to be compatible. Check before upgrading anything.
- **Retrieve the running project from the device** before editing — the archive is what
  *should* be there, not necessarily what is.
- Archive the project alongside the relay settings and the points list, versioned together.
  They are one system.

→ [RTAC Platform](atlas:rtac-automation/rtac-platform.html) · [Settings Management](atlas:relays-devices/settings-management.html) · [Firmware Upgrades](atlas:relays-devices/firmware-upgrades.html)

## Documentation gotcha

- The standalone `5033_IM` PDF that was originally on this machine was corrupt — **the full
  SEL-5033 software manual text lives inside `3530-4_IM`** in the SEL folder. Intact copies
  of the damaged PDFs were later found in `C:\SEL`; check there first when a PDF will not
  extract.

> Full detail lives on the pages linked above. This page is for the things that are quicker
> to remember than to look up.
