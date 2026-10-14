#!/usr/bin/env node
'use strict';
// Creates the anchor account key ON THE BOX. Prints ONLY the address and public key.
//   node bin/keygen.js /etc/xrpl-git-anchor/seed
// Refuses if the file exists (no accidental overwrite = no accidental loss of a funded key).
// The file is written 0400 with O_EXCL; run as root so it ends up root:root (systemd LoadCredential
// hands it to the service at runtime; the service user cannot read it otherwise).
const fs = require('node:fs');
const path = require('node:path');
const { Wallet } = require('xrpl');

const out = process.argv[2];
if (!out) { console.error('usage: keygen.js <seed-file-path>'); process.exit(2); }
if (fs.existsSync(out)) { console.error(`REFUSING: ${out} already exists. Existing address: run bin/status.js`); process.exit(3); }
const dir = path.dirname(out);
const dst = fs.statSync(dir);
if ((dst.mode & 0o077) !== 0) { console.error(`REFUSING: ${dir} must be mode 0700 (is ${(dst.mode & 0o777).toString(8)})`); process.exit(3); }

const w = Wallet.generate();                       // ed25519, from the OS CSPRNG
const fd = fs.openSync(out, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o400);
try { fs.writeSync(fd, w.seed + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
fs.chmodSync(out, 0o400);
// Re-read and confirm it round-trips to the same address before telling anyone to fund it.
const check = Wallet.fromSeed(fs.readFileSync(out, 'utf8').trim());
if (check.classicAddress !== w.classicAddress) { console.error('FATAL: seed file does not round-trip'); process.exit(4); }
console.log(`ADDRESS=${w.classicAddress}`);
console.log(`PUBLIC_KEY=${w.publicKey}`);
