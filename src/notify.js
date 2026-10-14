'use strict';
// ntfy push (https://ntfy.sh or a self-hosted ntfy). Optional and best-effort: a failed push never fails a run.
function createNotify({ ntfyBase, ntfyTopic, alertHost }, log = () => {}, fetchImpl = globalThis.fetch) {
  return async ({ title, body, priority = 'default' }) => {
    if (!ntfyTopic) { log('warn', 'notify_skipped_no_topic', { title }); return; }
    try {
      const res = await fetchImpl(`${ntfyBase.replace(/\/$/, '')}/${encodeURIComponent(ntfyTopic)}`, {
        method: 'POST', body, signal: AbortSignal.timeout(10000),
        headers: { Title: `[${alertHost}] ${title}`, Priority: priority, Tags: 'anchor' },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
    } catch (e) { log('warn', 'notify_failed', { title, error: e.message }); }
  };
}
module.exports = { createNotify };
