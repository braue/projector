// AcRTAC client — reaches the AcRTAC database through SEL's Python library
// (`from selacrtac.acrtac import AcRTAC`) via py/acrtac_bridge.py.
//
// Exposes the two calls the routes need:
//   listProjects()                 -> [{ name }]
//   exportXml({ name, directory }) -> resolves when the export is on disk

export { createAcRtacClient } from './pythonClient.js';
