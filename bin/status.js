#!/usr/bin/env node
'use strict';
// Read-only status: address, balance, last anchor, pending. Needs no seed, prints no secret.
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { createRpc } = require('../src/rpc');

(async () => {
  const cfg = loadConfig();
  const st = (() => { try { return JSON.parse(fs.readFileSync(path.join(cfg.stateDir, 'state.json'), 'utf8')); } catch { return {}; } })();
  console.log(`network     ${cfg.network}`);
  console.log(`account     ${cfg.account || '(ANCHOR_ACCOUNT not set)'}`);
  if (cfg.account) {
    const rpc = createRpc({ endpoints: cfg.endpoints });
    try {
      const ai = await rpc.call('account_info', { account: cfg.account, ledger_index: 'validated' });
      const d = ai.account_data;
      const dom = d.Domain ? Buffer.from(d.Domain, 'hex').toString('utf8') : '(none)';
      console.log(`balance     ${Number(d.Balance) / 1e6} XRP   sequence ${d.Sequence}   domain ${dom}`);
      console.log(`regular key ${d.RegularKey || '(none - only the box can sign)'}`);
    } catch (e) { console.log(`balance     ${e.code === 'actNotFound' ? 'NOT FUNDED YET - send ~10 XRP to the address above' : 'lookup failed: ' + e.message}`); }
  }
  console.log(`anchors     ${st.count || 0}`);
  if (st.last) console.log(`last        ${st.last.close_time_iso}  ledger ${st.last.ledger_index}  tx ${st.last.tx_hash}\n            commit ${st.last.commit}  tree ${st.last.tree_sha256}`);
  if (st.pending) console.log(`PENDING     ${st.pending.hash} (lls ${st.pending.lls}) - resolved on the next run`);
})().catch((e) => { console.error('status failed:', e.message); process.exit(1); });
