#!/usr/bin/env node
'use strict';
// Operator commands for the anchor account. Run by hand as root with the service's env file loaded
// (and the timer stopped), e.g.:
//   sudo systemctl stop xrpl-git-anchor.timer
//   sudo env $(grep -v '^#' /etc/xrpl-git-anchor.env | xargs) node bin/admin.js regular-key rYourWalletAddress
//   sudo systemctl start xrpl-git-anchor.timer
//
//   admin.js regular-key <rAddress|none> [--allow-unfunded] [--yes]
//   admin.js sweep <rAddress> [--tag N] [--allow-unfunded] [--yes]
//
// Signs with the seed file on the box (ANCHOR_ADMIN_SEED_PATH, default /etc/xrpl-git-anchor/seed); never
// prints it. Before anything is sent you must type the last 6 characters of the target address
// (--yes skips this, for scripted use only).
const readline = require('node:readline/promises');
const { loadConfig } = require('../src/config');
const { createRpc } = require('../src/rpc');
const { loadWallet } = require('../src/seed');
const { setRegularKey, sweep } = require('../src/submit');

async function confirm(target, what) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(`${what}\nType the last 6 characters of ${target} to confirm: `)).trim();
    if (a !== target.slice(-6)) throw new Error('confirmation did not match; nothing was sent');
  } finally { rl.close(); }
}

(async () => {
  const [cmd, target, ...rest] = process.argv.slice(2);
  const allowUnfunded = rest.includes('--allow-unfunded');
  const yes = rest.includes('--yes');
  const ti = rest.indexOf('--tag');
  const tag = ti >= 0 ? Number(rest[ti + 1]) : undefined;
  if (!['regular-key', 'sweep'].includes(cmd) || !target) {
    console.error('usage: admin.js regular-key <rAddress|none> [--allow-unfunded] [--yes] | sweep <rAddress> [--tag N] [--allow-unfunded] [--yes]');
    process.exit(2);
  }
  const cfg = loadConfig();
  if (!cfg.account) throw new Error('ANCHOR_ACCOUNT is not set');
  const wallet = loadWallet(process.env.ANCHOR_ADMIN_SEED_PATH || '/etc/xrpl-git-anchor/seed');
  if (wallet.classicAddress !== cfg.account) throw new Error('seed does not belong to ANCHOR_ACCOUNT');
  const rpc = createRpc({ endpoints: cfg.endpoints });
  if (cmd === 'regular-key') {
    const t = target === 'none' ? null : target;
    if (t && !yes) await confirm(t, `Set ${t} as the RegularKey of ${cfg.account} (${cfg.network}). That key will be able to sign for the anchor account.`);
    const r = await setRegularKey({ rpc, wallet, cfg, target: t, allowUnfunded });
    console.log(`REGULAR KEY ${t ? 'SET to ' + t : 'REMOVED'}  tx ${r.hash}  ledger ${r.ledger_index}  fee ${r.fee} drops`);
    if (t) console.log(`From now on ${t} can sign for ${cfg.account} (the box's key still works too).`);
  } else {
    if (!yes) await confirm(target, `Send everything above the reserve from ${cfg.account} (${cfg.network}) to ${target}${tag !== undefined ? ' tag ' + tag : ''}.`);
    const r = await sweep({ rpc, wallet, cfg, dest: target, tag, allowUnfunded });
    console.log(`SWEPT ${r.delivered_xrp ?? r.amount_xrp} XRP -> ${target}${tag !== undefined ? ' tag ' + tag : ''}  tx ${r.hash}  ledger ${r.ledger_index}`);
    console.log(`${r.reserve_left_xrp} XRP stays locked as the account reserve. Disable the timer if you are retiring this account.`);
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
