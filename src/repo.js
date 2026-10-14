'use strict';
// A private bare mirror of the anchored repository, owned by the anchor service user. The anchor never
// reads (or could write) anyone's working clone directly: it fetches the PUBLIC branch into its own mirror,
// falling back to a read-only fetch from the optional fallback source only if the primary is unreachable.
// Every anchored commit gets a ref (refs/anchor/anchored/<commit>) so the mirror keeps its objects
// forever, even if the repository's history were ever rewritten.

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { git, gitArgs, gitEnv } = require('./tree');

function ensureMirror(gitDir) {
  if (fs.existsSync(gitDir + '/HEAD')) return;
  const r = spawnSync('git', ['init', '-q', '--bare', gitDir], { env: gitEnv() });
  if (r.status !== 0) throw new Error('git init --bare failed: ' + String(r.stderr));
  git(gitDir, ['config', 'gc.auto', '0']);          // never auto-prune anything
}

// Fetch <branch> from `url` into refs/anchor/<name>/<branch>. Returns the commit id or throws.
function fetchSource(gitDir, { name, url, branch = 'main', timeoutMs = 120000 }) {
  const ref = `refs/anchor/${name}/${branch}`;
  const r = spawnSync('git', [...gitArgs(gitDir), 'fetch', '-q', '--no-tags', '--no-write-fetch-head', url, `+refs/heads/${branch}:${ref}`],
    { env: gitEnv(), timeout: timeoutMs, maxBuffer: 1 << 24 });
  if (r.error) throw new Error(`fetch ${name}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`fetch ${name} failed (${r.status}): ${String(r.stderr).trim().slice(0, 300)}`);
  return resolveCommit(gitDir, ref);
}

function resolveCommit(gitDir, rev) {
  const out = git(gitDir, ['rev-parse', '--verify', '-q', rev + '^{commit}']).stdout.toString().trim();
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(out)) throw new Error('bad commit id for ' + rev);
  return out;
}

function hasCommit(gitDir, commit) {
  return git(gitDir, ['cat-file', '-e', commit + '^{commit}'], { allowFail: true }).status === 0;
}

function isAncestor(gitDir, older, newer) {
  const r = git(gitDir, ['merge-base', '--is-ancestor', older, newer], { allowFail: true });
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw new Error('merge-base failed: ' + String(r.stderr).trim());
}

function pinCommit(gitDir, commit) {
  git(gitDir, ['update-ref', `refs/anchor/anchored/${commit}`, commit]);
}

// Tries each source in order; returns { commit, src } for the first that fetches.
function fetchFirst(gitDir, sources, log = () => {}) {
  const errors = [];
  for (const s of sources) {
    try {
      const commit = fetchSource(gitDir, s);
      return { commit, src: s.name, errors };
    } catch (e) {
      errors.push(e.message); log('warn', 'fetch_failed', { source: s.name, error: e.message });
    }
  }
  const err = new Error('no source fetched: ' + errors.join(' | '));
  err.code = 'NO_SOURCE';
  throw err;
}

module.exports = { ensureMirror, fetchSource, fetchFirst, resolveCommit, hasCommit, isAncestor, pinCommit };
