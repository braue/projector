// The test network: the last scan, a fresh scan, a device moved to a
// VLAN, an RTAC's Eth_02 address, the bench device table
// (whole-list GET/PUT), and an AcRTAC upload to one bench RTAC (a job).

import { Router } from 'express';

function testNetworkRoutes(testNetwork) {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(testNetwork.state());
  });

  router.post('/scan', async (req, res) => {
    res.json(await testNetwork.scan(req.body?.switchIp));
  });

  router.post('/move', async (req, res) => {
    res.json(await testNetwork.move(req.body ?? {}));
  });

  router.post('/eth02', async (req, res) => {
    res.json(await testNetwork.setEth02(req.body ?? {}));
  });

  router.get('/devices', async (_req, res) => {
    res.json({ devices: await testNetwork.devices() });
  });

  router.put('/devices', async (req, res) => {
    res.json({ devices: await testNetwork.saveDevices(req.body?.devices) });
  });

  router.post('/upload', async (req, res) => {
    res.status(202).json(await testNetwork.upload(req.body ?? {}));
  });

  return router;
}

export { testNetworkRoutes };
