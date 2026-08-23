import type { Edge } from '@xyflow/react'

import { TIER_COLOR, TIER_DASH, worstTier } from './tiers'
import type { GraphLink, WorkspaceGraph } from '../types'

// Turning the linker's links into the wires the canvas draws.
//
// The rule that shapes all of this: a wire is a physical run, and a logical
// connection rides one. When the linker has resolved a connection onto drawn
// cable (`link.path`), it gets no wire of its own — the cables it travels are
// painted for it. Otherwise the topology isn't stated and the connection is
// drawn as a direct chord between its two devices, which is the best the
// canvas can honestly say.
//
// Pure, so the wiring rules can be exercised without mounting React Flow.

/**
 * Every referenced-but-not-placed far end (the linker's ghosts) condenses into
 * ONE hub node — 150 individual ghost boxes would drown the canvas — so
 * `ghost` on a node means the hub.
 */
export const GHOST_HUB_ID = 'ghost-hub'

/** What a wire's popup needs: the run itself, and what travels it. */
export type WireData = { link?: GraphLink; carries?: GraphLink[]; hubLinks?: GraphLink[] }

export interface Trace {
  /** A connection pinned from a wire's popup — its whole run stays lit. */
  tracedLinkId: string | null
  /** A device under the cursor — everything it talks to lights up. */
  hoveredDeviceId: string | null
}

const FADED = 0.12

export function buildWires(graph: WorkspaceGraph | null, trace: Trace): Edge[] {
  const links = graph?.links ?? []
  const out: Edge[] = []

  // Two things indexed by segment id, in one pass: which connections ride each
  // drawn cable, and which wire is drawn for it — the latter so a path (which
  // names manual link ids) becomes wire ids without assuming how the linker
  // spells them.
  const carried = new Map<string, GraphLink[]>()
  const wireIdByManual = new Map<string, string>()
  for (const link of links) {
    if (link.manualId) wireIdByManual.set(link.manualId, link.id)
    for (const manualId of link.path ?? []) {
      const riders = carried.get(manualId)
      if (riders) riders.push(link)
      else carried.set(manualId, [link])
    }
  }

  /** The wires a connection occupies: its run, or the one chord drawn for it. */
  const wiresFor = (link: GraphLink): string[] =>
    link.path
      ? link.path
          .map((manualId) => wireIdByManual.get(manualId))
          .filter((id): id is string => Boolean(id))
      : [link.id]

  // What to keep lit. A pinned connection wins over a hover — you asked for
  // that one specifically. Null means nothing is being traced, so everything
  // reads at full strength.
  let traced: Set<string> | null = null
  if (trace.tracedLinkId) {
    const link = links.find((candidate) => candidate.id === trace.tracedLinkId)
    if (link) traced = new Set(wiresFor(link))
  } else if (trace.hoveredDeviceId) {
    // Everything this device says it talks to, along the whole run each
    // conversation takes — including cables it is not itself an end of.
    const touching = links.filter(
      (link) =>
        link.sourceDeviceId === trace.hoveredDeviceId ||
        link.targetDeviceId === trace.hoveredDeviceId,
    )
    if (touching.length) traced = new Set(touching.flatMap(wiresFor))
  }
  const lit = (id: string) => !traced || traced.has(id)

  // Ghost-bound links collapse with their targets: one wire per source device
  // to the hub, carrying its links so the wire's popup can show each declared
  // connection's summary and checks.
  const toHub = new Map<string, GraphLink[]>()

  for (const link of links) {
    if (link.path) continue // rides the fabric — the cables carry it
    if (!link.targetDeviceId) {
      const hubLinks = toHub.get(link.sourceDeviceId) ?? []
      hubLinks.push(link)
      toHub.set(link.sourceDeviceId, hubLinks)
      continue
    }
    const carries = link.manualId ? carried.get(link.manualId) ?? [] : []
    // A cable is painted by the worst thing riding it: one conflicting
    // connection makes the whole run red, because that run is where a reader
    // has to go looking.
    const tier = worstTier([link.tier, ...carries.map((rider) => rider.tier)])
    const on = lit(link.id)
    out.push({
      id: link.id,
      source: link.sourceDeviceId,
      target: link.targetDeviceId,
      type: 'floating',
      style: {
        stroke: TIER_COLOR[tier],
        strokeWidth: traced && on ? 3.5 : 2,
        strokeDasharray: TIER_DASH[tier],
        opacity: on ? 1 : FADED,
      },
      data: { link, carries } satisfies WireData,
      interactionWidth: 16,
    })
  }

  for (const [sourceId, hubLinks] of toHub) {
    // The hub wire belongs to its source, so a trace involving that device
    // keeps it lit along with everything else the device declares.
    const on = !traced || sourceId === trace.hoveredDeviceId
    out.push({
      id: `ghosts:${sourceId}`,
      source: sourceId,
      target: GHOST_HUB_ID,
      type: 'floating',
      style: {
        stroke: TIER_COLOR.declared,
        strokeWidth: 2,
        strokeDasharray: TIER_DASH.declared,
        opacity: on ? 1 : FADED,
      },
      data: { hubLinks } satisfies WireData,
      interactionWidth: 16,
    })
  }

  return out
}
