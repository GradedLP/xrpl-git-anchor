#!/usr/bin/env node
'use strict';
// Live rehearsal on the XRPL TESTNET with a faucet-funded throwaway key (held in memory only):
//   fetch a real public repository -> tree_sha256 -> anchor tx -> validated ->
//   second run is a no-op -> verify_anchor.py re-derives everything from public testnet nodes.
// Touches nothing on mainnet and nothing outside a temp dir.
//   npm run e2e:testnet                                   # anchors this project's own public repo
//   E2E_REPO_URL=https://github.com/you/repo.git npm run e2e:testnet
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Wallet } = require('xrpl');
const { runOnce } = require('../src/anchor');
const { createRpc, ENDPOINTS } = require('../src/rpc');
const { log } = require('../src/log');

const endpoints = process.env.ANCHOR_RPC ? process.env.ANCHOR_RPC.split(',') : ENDPOINTS.testnet;
const repoUrl = process.env.E2E_REPO_URL || 'https://github.com/GradedLP/xrpl-git-anchor.git';

(async () => {
  const f = await fetch('https://faucet.altnet.rippletest.net/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const fj = await f.json();
  const wallet = Wallet.fromSeed(fj.seed);                    // throwaway testnet key; never written anywhere
  if (wallet.classicAddress !== fj.account.address) throw new Error('faucet seed/address mismatch');
  log('info', 'faucet_funded', { account: wallet.classicAddress });
  const rpc = createRpc({ endpoints, log });
  for (let i = 0; i < 30; i++) {                               // wait until the funding is validated
    try { await rpc.call('account_info', { account: wallet.classicAddress, ledger_index: 'validated' }); break; }
    catch { await new Promise((r) => setTimeout(r, 2000)); }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-e2e-'));
  const cfg = {
    network: 'testnet', account: wallet.classicAddress, repoUrl, repoId: repoUrl.replace(/\.git$/, ''),
    branch: process.env.E2E_BRANCH || 'main', memoType: 'xrpl-git-anchor/v1', label: 'e2e', sourceName: 'primary', fallbackUrl: '',
    stateDir: dir, mirrorDir: path.join(dir, 'mirror.git'), publicDir: path.join(dir, 'public'),
    heartbeatHours: 24, maxFeeDrops: 5000, minSpendableXrp: 2, lastLedgerOffset: 20, waitMs: 180000, pollMs: 3000,
    domain: '',
  };
  const r1 = await runOnce({ cfg, rpc, wallet, log });
  if (r1.action !== 'anchored') throw new Error('first run did not anchor: ' + r1.action);
  let r2 = await runOnce({ cfg, rpc, wallet, log });
  if (r2.action === 'anchored' && r2.proof.memo.commit !== r1.proof.memo.commit) {
    log('info', 'branch_moved_between_runs', { from: r1.proof.memo.commit, to: r2.proof.memo.commit });
    r2 = await runOnce({ cfg, rpc, wallet, log });            // a live repo may move; the next run must then be a no-op
  }
  if (r2.action !== 'unchanged') throw new Error('a run on an unchanged branch should be a no-op: ' + r2.action);

  const py = path.join(__dirname, '..', 'verify', 'verify_anchor.py');
  const some = execFileSync('git', ['--git-dir', cfg.mirrorDir, 'ls-tree', '-r', '--name-only', r1.proof.memo.commit], { encoding: 'utf8' })
    .split('\n').filter(Boolean)[0];
  // verify_anchor.py needs a working clone; a bare mirror works with git -C too.
  let out = '';
  for (let i = 0; i < 10; i++) {                                // account_tx indexes can lag a few seconds
    try {
      out = execFileSync('python3', [py, '--repo', cfg.mirrorDir, '--account', wallet.classicAddress, '--network', 'testnet',
        ...endpoints.flatMap((e) => ['--rpc', e]), '--file', some, '--at', r1.proof.memo.commit], { encoding: 'utf8' });
      break;
    } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); await new Promise((r) => setTimeout(r, 3000)); }
  }
  process.stdout.write(out);
  if (!/OK: [1-9]\d* verified, 0 problem/.test(out) || !/PROVEN:/.test(out)) throw new Error('verifier did not confirm the testnet anchor');
  console.log(`\nE2E TESTNET PASS  tx ${r1.proof.tx_hash}  ledger ${r1.proof.ledger_index}  ${r1.proof.close_time_iso}`);
  console.log(`  commit ${r1.proof.memo.commit}  tree_sha256 ${r1.proof.memo.tree_sha256}  files ${r1.proof.memo.files}  fee ${r1.proof.fee_drops} drops`);
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.error('E2E FAILED:', e.message); process.exit(1); });
