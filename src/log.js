'use strict';
// One JSON object per line on stdout -> journald. Never pass secrets in here.
function log(level, event, fields = {}) {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level, event, ...fields }) + '\n');
}
module.exports = { log };
