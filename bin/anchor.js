#!/usr/bin/env node
'use strict';
// One anchor run (xrpl-git-anchor.service). Exit 0 = anchored or nothing to do; non-zero -> OnFailure alert.
const { loadConfig } = require('../src/config');
const { createRpc } = require('../src/rpc');
const { loadWallet } = require('../src/seed');
const { createNotify } = require('../src/notify');
const { runOnce } = require('../src/anchor');
const { log } = require('../src/log');

(async () => {
  const cfg = loadConfig();
  const wallet = loadWallet(cfg.seedPath);
  const rpc = createRpc({ endpoints: cfg.endpoints, log });
  const notify = createNotify(cfg, log);
  const r = await runOnce({ cfg, rpc, wallet, log, notify });
  log('info', 'done', { action: r.action });
})().catch((e) => { log('error', 'run_failed', { error: e.message }); process.exit(1); });
