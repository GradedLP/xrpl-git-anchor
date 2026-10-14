'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Wallet } = require('xrpl');

// Loads the wallet from the key file. The seed string lives only inside this function and the Wallet
// object; it is never logged, returned, or placed in the environment.
//
// Permission rule:
//  - never readable by "other";
//  - group bits allowed ONLY on the systemd credential copy inside the service's private
//    $CREDENTIALS_DIRECTORY. systemd writes it 0440 owned by root and grants the service user read
//    through a POSIX ACL; with an ACL present the "group" bits shown by stat are the ACL mask, not
//    a real group grant. So there the group must be root (gid 0) or the service's own dedicated
//    group. Anywhere else (e.g. /etc/xrpl-git-anchor/seed) the file must be owner-only.
function loadWallet(seedPath, env = process.env) {
  if (!seedPath) throw new Error('no seed credential (systemd LoadCredential=seed:/etc/xrpl-git-anchor/seed)');
  const st = fs.statSync(seedPath);
  const mode = st.mode & 0o777;
  const shown = mode.toString(8);
  if (mode & 0o007) throw new Error(`seed file ${seedPath} is readable by other users (mode ${shown})`);
  if (mode & 0o070) {
    const credDir = env.CREDENTIALS_DIRECTORY ? path.resolve(env.CREDENTIALS_DIRECTORY) : '';
    const inCredDir = credDir && path.dirname(path.resolve(seedPath)) === credDir;
    const safeGroup = st.gid === 0 || (typeof process.getgid === 'function' && st.gid === process.getgid());
    if (!(inCredDir && safeGroup)) throw new Error(`seed file ${seedPath} is group-readable (mode ${shown}) outside the service's own credentials dir (or group ${st.gid} is neither root nor the service's own)`);
  }
  const s = fs.readFileSync(seedPath, 'utf8').trim();
  let w;
  try { w = Wallet.fromSeed(s); } catch { throw new Error('seed file does not hold a valid XRPL family seed'); }
  return w;
}
module.exports = { loadWallet };
