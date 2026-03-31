const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { spawn } = require('child_process');
const { webhookLimiter } = require('../middleware/security');

function verifySignature(req) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    console.error('❌ GITHUB_WEBHOOK_SECRET not configured - rejecting webhook');
    return false;
  }
  const sig256 = req.headers['x-hub-signature-256'];
  const raw = req.rawBody || null;
  if (!sig256 || !raw) return false;
  const hmac = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const expected = 'sha256=' + hmac;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig256));
  } catch (e) {
    return false;
  }
}

router.post('/webhook', webhookLimiter, (req, res) => {
  if (!verifySignature(req)) {
    console.warn('⚠️  Invalid webhook signature from IP:', req.ip);
    return res.status(401).json({ error: 'invalid signature' });
  }
  const event = req.headers['x-github-event'];
  if (!event) return res.status(400).json({ error: 'missing event header' });
  if (!['push', 'workflow_run'].includes(event)) return res.status(202).json({ ok: true, info: 'event ignored' });

  // Log the webhook trigger
  console.log('✅ Webhook triggered:', { event, ip: req.ip, timestamp: new Date().toISOString() });

  // Spawn the sync script in background
  const cmd = process.env.SYNC_COMMAND || 'node';
  const args = process.env.SYNC_ARGS ? process.env.SYNC_ARGS.split(' ') : ['scripts/sync-rando-list.js'];
  const child = spawn(cmd, args, { env: { ...process.env }, detached: true, stdio: 'ignore' });
  child.unref();

  res.json({ started: true });
});

module.exports = router;
