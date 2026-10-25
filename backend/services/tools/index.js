// The tools bundle — one constructor for everything behind /api/tools, so
// the server wires a single object and each new tool is one line here.

import { AcrtacService } from './acrtac.js';
import { DacInitService } from './dacinit.js';
import { DacsimService } from './dacsim.js';
import { DwgenService } from './dwgen.js';
import { FatSheetsService } from './fatsheets.js';
import { HmiTesterService } from './hmiTester.js';
import { QuicksetService } from './quickset/index.js';
import { RtacExportService } from './rtacExport.js';
import { SelTerminalService } from './selTerminal.js';
import { SwsetService } from './swset/index.js';
import { ToolsWorkspace } from './workspace.js';

async function createTools({ dataDir, jobs, catalog, settings }) {
  const workspace = new ToolsWorkspace({ dataDir });
  await workspace.init();
  const hmi = new HmiTesterService({ workspace });
  const terminal = new SelTerminalService();
  const quickset = new QuicksetService({ workspace, jobs });
  const swset = new SwsetService({ workspace });
  const rtacExport = new RtacExportService({ workspace, jobs, catalog });
  const dwgen = new DwgenService({ workspace, jobs, settings });
  const dacsim = new DacsimService({ workspace, jobs });
  const dacinit = new DacInitService({ workspace, jobs });
  const fatsheets = new FatSheetsService({ workspace, jobs });
  const acrtac = new AcrtacService({ jobs, catalog });
  return {
    workspace, hmi, terminal, quickset, swset, rtacExport,
    dwgen, dacsim, dacinit, fatsheets, acrtac,
  };
}

export { createTools };
