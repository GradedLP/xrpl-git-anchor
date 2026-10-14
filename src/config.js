'use strict';
const os = require('node:os');
const path = require('node:path');
const { ENDPOINTS } = require('./rpc');
const { DEFAULT_MEMO_TYPE, MEMO_TYPE_RE, SRC_RE } = require('./memo');

// All configuration comes from the environment (systemd EnvironmentFile). See deploy/xrpl-git-anchor.env.example.
//
// The seed must only ever arrive as a file (systemd LoadCredential). An env var holding a seed would
// leak into `systemctl show`, /proc/<pid>/environ and crash dumps, so boot refuses one outright.
const FORBIDDEN_KEY = /(^|_)(SEED|FAMILY_SEED|PRIVATE_KEY|WALLET_SECRET|MNEMONIC|SECRET)$/i;
const SEED_LIKE = /^s[1-9A-HJ-NP-Za-km-z]{24,34}$/;   // XRPL family seed (secp256k1 "s…" / ed25519 "sEd…")

function loadConfig(env = process.env) {
  const bad = Object.keys(env).filter((k) => FORBIDDEN_KEY.test(k) || SEED_LIKE.test(String(env[k] || '').trim()));
  if (bad.length) throw new Error(`refusing to start: environment holds a secret (${bad.join(', ')}). The seed is read from a credential file only.`);

  const network = env.ANCHOR_NETWORK;
  if (!['mainnet', 'testnet'].includes(network)) throw new Error('ANCHOR_NETWORK must be mainnet or testnet');
  const account = (env.ANCHOR_ACCOUNT || '').trim();
  if (account && !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(account)) throw new Error('ANCHOR_ACCOUNT is not a classic address');

  const repoUrl = (env.ANCHOR_REPO_URL || '').trim();
  if (!repoUrl) throw new Error('ANCHOR_REPO_URL is required (the public https URL of the repository to anchor)');
  if (!/^https:\/\//.test(repoUrl)) throw new Error('ANCHOR_REPO_URL must be https');
  const repoId = (env.ANCHOR_REPO_ID || repoUrl.replace(/\.git$/, '')).trim();
  if (!/^https:\/\/[\x21-\x7e]{1,200}$/.test(repoId)) throw new Error('ANCHOR_REPO_ID must be an https URL of at most 200 printable ASCII characters');

  const memoType = env.ANCHOR_MEMO_TYPE || DEFAULT_MEMO_TYPE;
  if (!MEMO_TYPE_RE.test(memoType)) throw new Error('ANCHOR_MEMO_TYPE must be 1-64 printable ASCII characters, no spaces');
  const sourceName = env.ANCHOR_SOURCE_NAME || 'primary';
  const fallbackName = env.ANCHOR_FALLBACK_NAME || 'fallback';
  for (const [k, v] of [['ANCHOR_SOURCE_NAME', sourceName], ['ANCHOR_FALLBACK_NAME', fallbackName]]) {
    if (!SRC_RE.test(v)) throw new Error(`${k} must match ${SRC_RE}`);
  }
  if (sourceName === fallbackName) throw new Error('ANCHOR_SOURCE_NAME and ANCHOR_FALLBACK_NAME must differ');

  const num = (k, d, min, max) => {
    const v = env[k] === undefined || env[k] === '' ? d : Number(env[k]);
    if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${k} out of range [${min}, ${max}]`);
    return v;
  };
  const stateDir = env.ANCHOR_STATE_DIR || env.STATE_DIRECTORY;
  if (!stateDir) throw new Error('ANCHOR_STATE_DIR is required (systemd StateDirectory= sets STATE_DIRECTORY for you)');
  const credDir = env.CREDENTIALS_DIRECTORY;
  return {
    network, account,
    repoUrl, repoId, memoType,
    branch: env.ANCHOR_BRANCH || 'main',
    sourceName,
    fallbackUrl: (env.ANCHOR_FALLBACK_URL || '').trim(),   // optional second source (e.g. a local clone)
    fallbackName,
    stateDir,
    mirrorDir: path.join(stateDir, 'mirror.git'),
    publicDir: env.ANCHOR_PUBLIC_DIR || '',               // optional: where index.json / latest.json / files.json go
    label: env.ANCHOR_LABEL || repoId,                    // human name used in alerts and the public index
    seedPath: env.ANCHOR_SEED_PATH || (credDir ? path.join(credDir, 'seed') : ''),
    heartbeatHours: num('ANCHOR_HEARTBEAT_HOURS', 24, 1, 24 * 7),
    maxFeeDrops: num('ANCHOR_MAX_FEE_DROPS', 5000, 10, 100000),
    minSpendableXrp: num('ANCHOR_MIN_SPENDABLE_XRP', 2, 0, 1000),
    lastLedgerOffset: num('ANCHOR_LLS_OFFSET', 20, 4, 200),
    waitMs: num('ANCHOR_WAIT_MS', 180000, 10000, 900000),
    pollMs: num('ANCHOR_POLL_MS', 3000, 1, 60000),
    domain: env.ANCHOR_DOMAIN || '',                      // optional: sets the account's Domain field on first anchor
    endpoints: env.ANCHOR_RPC ? env.ANCHOR_RPC.split(',').map((s) => s.trim()).filter(Boolean) : ENDPOINTS[network],
    ntfyBase: env.ANCHOR_NTFY_BASE || 'https://ntfy.sh',
    ntfyTopic: env.ANCHOR_NTFY_TOPIC || '',
    alertHost: env.ALERT_HOST || os.hostname(),
  };
}

module.exports = { loadConfig, FORBIDDEN_KEY, SEED_LIKE };
