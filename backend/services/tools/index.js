// The tools bundle — one constructor for everything behind /api/tools, so
// the server wires a single object and each new tool is one line here.

import { DwgenService } from './dwgen.js';
import { HmiTesterService } from './hmiTester.js';
import { JobRegistry } from './jobs.js';
import { QuicksetService } from './quickset/index.js';
import { RtacExportService } from './rtacExport.js';
import { SelTerminalService } from './selTerminal.js';
import { SwsetService } from './swset/index.js';
import { ToolSettings } from './settings.js';
import { ToolsWorkspace } from './workspace.js';

async function createTools({ dataDir }) {
  const workspace = new ToolsWorkspace({ dataDir });
  await workspace.init();
  const settings = new ToolSettings({ dataDir });
  const jobs = new JobRegistry();
  const hmi = new HmiTesterService({ workspace });
  const terminal = new SelTerminalService();
  const quickset = new QuicksetService({ workspace, jobs });
  const swset = new SwsetService({ workspace });
  const rtacExport = new RtacExportService({ workspace, jobs });
  const dwgen = new DwgenService({ workspace, jobs, settings });
  return { workspace, settings, jobs, hmi, terminal, quickset, swset, rtacExport, dwgen };
}

export { createTools };
