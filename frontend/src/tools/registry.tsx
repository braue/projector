// The tool registry — the Tools rail renders this list, and adding a tool to
// the pane is one entry here plus its component. Tools are global utilities:
// they take inputs dragged in from the project tree (or from disk), and
// their outputs drag back onto a tree folder to be kept.

import type { ComponentType } from 'react'

import { DacInitTool } from './DacInitTool'
import { DacsimTool } from './DacsimTool'
import { DwgenTool } from './DwgenTool'
import { FatSheetsTool } from './FatSheetsTool'
import { HmiTesterTool } from './HmiTesterTool'
import { QuicksetTool } from './QuicksetTool'
import { RtacExportTool } from './RtacExportTool'
import { SelTerminalTool } from './SelTerminalTool'
import { SwsetTool } from './SwsetTool'

/** Every tool component gets the open project and whether it is the visible
 *  tool (opened tools stay mounted while hidden). Inputs come from the tree
 *  by drag, not from the open project (lib/treeDrag). */
export interface ToolProps {
  project: string
  active: boolean
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
  { id: 'dacinit', label: 'CLECO DAC Inits', component: DacInitTool },
  { id: 'fatsheets', label: 'Automatic FAT → Excel', component: FatSheetsTool },
]
