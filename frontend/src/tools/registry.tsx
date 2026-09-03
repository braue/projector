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
  component: ComponentType<ToolProps>
}

export const TOOLS: ToolDef[] = [
  { id: 'hmi', label: 'HMI Tag Tester', component: HmiTesterTool },
  { id: 'terminal', label: 'SEL Terminal', component: SelTerminalTool },
  { id: 'swset', label: 'Switch Settings', component: SwsetTool },
  { id: 'quickset', label: 'QuickSet Extract', component: QuicksetTool },
  { id: 'rtac-export', label: 'RTAC Exporter', component: RtacExportTool },
  { id: 'dwgen', label: 'Drawing Generator', component: DwgenTool },
  { id: 'dacsim', label: 'DAC SIM Converter', component: DacsimTool },
]
