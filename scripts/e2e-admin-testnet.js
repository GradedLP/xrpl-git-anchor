#!/usr/bin/env node
'use strict';
// Live TESTNET rehearsal of the recovery path (throwaway faucet keys, memory only):
//   box key sets RegularKey -> a second ("Xaman") key alone moves XRP out of the anchor account ->
//   box key sweeps the rest -> exactly the reserve remains.      npm run e2e:admin
const { Wallet } = require('xrpl');
const { createRpc, ENDPOINTS } = require('../src/rpc');
const { setRegularKey, sweep, signSubmitWait, accountInfo } = require('../src/submit');

const endpoints = process.env.ANCHOR_RPC ? process.env.ANCHOR_RPC.split(',') : ENDPOINTS.testnet;
const faucet = async () => {
  const j = await (await fetch('https://faucet.altnet.rippletest.net/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  return Wallet.fromSeed(j.seed);
};

(async () => {
  const rpc = createRpc({ endpoints });
  const box = await faucet(); const xaman = await faucet();
  for (const w of [box, xaman]) for (let i = 0; i < 30 && !(await accountInfo(rpc, w.classicAddress)); i++) await new Promise((r) => setTimeout(r, 2000));
  const cfg = { account: box.classicAddress, maxFeeDrops: 5000, lastLedgerOffset: 20, waitMs: 180000, pollMs: 3000 };
  console.log('anchor(box)', box.classicAddress, ' xaman', xaman.classicAddress);

  let refused = false;
  try { await signSubmitWait(rpc, xaman, { TransactionType: 'Payment', Account: box.classicAddress, Destination: xaman.classicAddress, Amount: '500000' }, cfg); }
  catch (e) { refused = true; console.log('before regular key, xaman-signed payment:', e.message); }
  if (!refused) throw new Error('xaman key could sign before RegularKey was set?!');

  const rk = await setRegularKey({ rpc, wallet: box, cfg, target: xaman.classicAddress });
  console.log('SetRegularKey', rk.hash, 'ledger', rk.ledger_index);
  const p = await signSubmitWait(rpc, xaman, { TransactionType: 'Payment', Account: box.classicAddress, Destination: xaman.classicAddress, Amount: '500000' }, cfg);
  console.log('xaman-signed payment from the anchor account: tesSUCCESS', p.hash);

  const s = await sweep({ rpc, wallet: box, cfg, dest: xaman.classicAddress });
  const left = await accountInfo(rpc, box.classicAddress);
  console.log(`sweep ${s.amount_xrp} XRP ${s.hash}; anchor account left with ${Number(left.Balance) / 1e6} XRP (reserve ${s.reserve_left_xrp})`);
  if (Number(left.Balance) / 1e6 !== s.reserve_left_xrp) throw new Error('reserve mismatch after sweep');
  console.log('\nE2E ADMIN TESTNET PASS');
})().catch((e) => { console.error('E2E ADMIN FAILED:', e.message); process.exit(1); });
