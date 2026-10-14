'use strict';
// tree_sha256 (TREE_V1) — a SHA-256 commitment to every file in a git commit.
//
// Git object ids in most repositories are SHA-1, and SHA-1 collisions are practical, so the git commit id alone
// is not a strong enough fingerprint to anchor. TREE_V1 re-hashes every file's bytes with SHA-256:
//
//   for each entry of `git ls-tree -r -z --full-tree <commit>`:
//     blob    -> "<mode> <sha256(file bytes)> <path>\n"
//     gitlink -> "<mode> gitlink:<oid> <path>\n"
//   lines sorted by raw path bytes; tree_sha256 = sha256(all lines concatenated); files = entry count.
//
// verify_anchor.py implements the same definition independently (stdlib only); the tests pin that the
// two agree on awkward paths (spaces, unicode, exec bits, symlinks, nesting, empty files).

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function gitArgs(gitDir) {
  return ['-c', 'safe.directory=*', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '--git-dir', gitDir];
}
function gitEnv(extra = {}) {
  const env = { PATH: process.env.PATH || '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  if (process.env.HOME) env.HOME = process.env.HOME;
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'GIT_SSL_CAINFO', 'SSL_CERT_FILE']) {
    if (process.env[k]) env[k] = process.env[k];
  }
  return { ...env, ...extra };
}

function git(gitDir, args, { input, maxBuffer = 1 << 30, allowFail = false } = {}) {
  const r = spawnSync('git', [...gitArgs(gitDir), ...args], { input, maxBuffer, env: gitEnv() });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args[0]} failed (${r.status}): ${String(r.stderr || '').trim().slice(0, 400)}`);
  }
  return r;
}

function lsTree(gitDir, commit) {
  const out = git(gitDir, ['ls-tree', '-r', '-z', '--full-tree', commit]).stdout;
  const entries = [];
  let i = 0;
  while (i < out.length) {
    const z = out.indexOf(0, i);
    const rec = out.subarray(i, z === -1 ? out.length : z);
    i = z === -1 ? out.length : z + 1;
    if (!rec.length) continue;
    const tab = rec.indexOf(9);
    const [mode, type, oid] = rec.subarray(0, tab).toString('latin1').split(' ');
    entries.push({ mode, type, oid, path: Buffer.from(rec.subarray(tab + 1)) });
  }
  return entries;
}

// Reads many blobs with one `git cat-file --batch`. Returns Map oid -> Buffer.
function readBlobs(gitDir, oids) {
  const res = new Map();
  if (!oids.length) return res;
  const out = git(gitDir, ['cat-file', '--batch'], { input: oids.join('\n') + '\n' }).stdout;
  let i = 0;
  for (const want of oids) {
    const nl = out.indexOf(10, i);
    const [oid, type, size] = out.subarray(i, nl).toString('latin1').split(' ');
    if (oid !== want || type !== 'blob') throw new Error(`cat-file: expected blob ${want}, got ${oid} ${type}`);
    const n = Number(size);
    res.set(oid, out.subarray(nl + 1, nl + 1 + n));
    i = nl + 1 + n + 1;
  }
  return res;
}

// cache: optional Map oid -> sha256 hex (blob content is immutable per oid, so this is always safe).
function treeSha256(gitDir, commit, cache = new Map()) {
  const entries = lsTree(gitDir, commit);
  const need = [...new Set(entries.filter((e) => e.type === 'blob' && !cache.has(e.oid)).map((e) => e.oid))];
  for (const [oid, buf] of readBlobs(gitDir, need)) cache.set(oid, crypto.createHash('sha256').update(buf).digest('hex'));
  entries.sort((a, b) => Buffer.compare(a.path, b.path));
  const h = crypto.createHash('sha256');
  for (const e of entries) {
    let fp;
    if (e.type === 'blob') fp = cache.get(e.oid);
    else if (e.type === 'commit') fp = 'gitlink:' + e.oid;
    else throw new Error(`unexpected ls-tree entry type ${e.type}`);
    h.update(Buffer.from(`${e.mode} ${fp} `, 'latin1'));
    h.update(e.path);
    h.update(Buffer.from('\n'));
  }
  return { tree_sha256: h.digest('hex'), files: entries.length };
}

// Per-file SHA-256 of every blob in `commit` (same bytes TREE_V1 hashes). Paths decoded as UTF-8.
function fileHashes(gitDir, commit, cache = new Map()) {
  const entries = lsTree(gitDir, commit).filter((e) => e.type === 'blob');
  const need = [...new Set(entries.filter((e) => !cache.has(e.oid)).map((e) => e.oid))];
  for (const [oid, buf] of readBlobs(gitDir, need)) cache.set(oid, crypto.createHash('sha256').update(buf).digest('hex'));
  return entries.map((e) => ({ path: e.path.toString('utf8'), sha256: cache.get(e.oid) }));
}

module.exports = { treeSha256, fileHashes, lsTree, readBlobs, git, gitArgs, gitEnv };
