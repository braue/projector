// The tool registry — the Tools rail renders this list, and adding a tool to
// the pane is one entry here plus its component. Tools are global utilities:
// they take ad-hoc inputs regardless of the current project, and offer
// "save to project" for results worth keeping.

import type { ComponentType } from 'react'

import { DacsimTool } from './DacsimTool'
import { DwgenTool } from './DwgenTool'
import { HmiTesterTool } from './HmiTesterTool'
import { QuicksetTool } from './QuicksetTool'
import { RtacExportTool } from './RtacExportTool'
import { SelTerminalTool } from './SelTerminalTool'
import { SwsetTool } from './SwsetTool'

/** A jump into the pane from elsewhere in the app (a canvas device popup's
 *  "Connection drawing"): which tool to open, with what prefill. `n` bumps on
 *  every request, so asking again for the same device still lands. */
export interface ToolSeek {
  tool: string
  n: number
  dwgen?: { partNumber: string | null; model: string | null }
}

/** Every tool component gets the current project (for save-to-project) and
 *  whether it is the visible tool (opened tools stay mounted while hidden). */
export interface ToolProps {
  project: string
  active: boolean
  /** Set when this tool was opened by a seek — prefill from it. */
  seek?: ToolSeek
}

export interface ToolDef {
  id: string
  label: string
  /** One-line description shown in the rail and the tool's empty state. */
  blurb: string
  component: ComponentType<ToolProps>
}

export const TOOLS: ToolDef[] = [
  {
    id: 'hmi',
    label: 'HMI Tag Tester',
    blurb: 'Audit a Diagram Builder HMI project for bad and duplicate tags',
    component: HmiTesterTool,
  },
  {
    id: 'terminal',
    label: 'SEL Terminal',
    blurb: 'ASCII terminal to a relay over telnet or a serial-to-Ethernet converter',
    component: SelTerminalTool,
  },
  {
    id: 'swset',
    label: 'Switch Settings',
    blurb: 'Edit SEL managed-switch configuration XML in a form',
    component: SwsetTool,
  },
  {
    id: 'quickset',
    label: 'QuickSet Extract',
    blurb: 'Dump a QuickSet database and extract settings across a relay fleet',
    component: QuicksetTool,
  },
  {
    id: 'rtac-export',
    label: 'RTAC Exporter',
    blurb: 'Bulk-export AcRTAC database projects as XML or EXP',
    component: RtacExportTool,
  },
  {
    id: 'dwgen',
    label: 'Drawing Generator',
    blurb: 'Configured connection drawings from an SEL part number',
    component: DwgenTool,
  },
  {
    id: 'dacsim',
    label: 'DAC SIM Converter',
    blurb: 'Build simulator projects from an exported DAC project bundle',
    component: DacsimTool,
  },
]
