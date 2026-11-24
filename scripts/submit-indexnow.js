#!/usr/bin/env node
/**
 * Submit to IndexNow (Bing, Yandex, Seznam, Naver…) the pages of the sitemap that
 * are new or changed since the last submission: all of them the first time. Run
 * daily by the crontab (task `indexnow`).
 *
 * Needs INDEXNOW_KEY in .env (the server then serves it at /<key>.txt) and reads the
 * sitemap of SITE_URL. The date of the last submission is kept in
 * $LOG_DIR/status/indexnow-state.json.
 *
 * Usage:
 *   node scripts/submit-indexnow.js [--dry-run] [--all]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const { isIndexNowKey, parseSitemap, pagesToSubmit, chunk } = require('../helpers/indexnow');

const ENDPOINT = 'https://api.indexnow.org/indexnow';
const SITE = (process.env.SITE_URL || 'https://randomizer.games').replace(/\/+$/, '');
const STATE_FILE = path.join(process.env.LOG_DIR || path.join(os.homedir(), 'logs'), 'status', 'indexnow-state.json');
const dryRun = process.argv.includes('--dry-run');
const all = process.argv.includes('--all');

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

async function main() {
  const key = process.env.INDEXNOW_KEY;
  if (!isIndexNowKey(key)) {
    console.error('❌ INDEXNOW_KEY absente ou invalide dans .env');
    return 2;
  }
  if (!dryRun) {
    // The engines check the key there before taking the pages
    const served = (await fetchText(`${SITE}/${key}.txt`)).trim();
    if (served !== key) throw new Error(`${SITE}/${key}.txt ne renvoie pas la clé`);
  }

  const entries = [];
  for (const sitemap of parseSitemap(await fetchText(`${SITE}/sitemap.xml`))) {
    entries.push(...parseSitemap(await fetchText(sitemap.loc)));
  }
  const state = readState();
  const startedAt = new Date().toISOString();
  const pages = pagesToSubmit(entries, all ? null : state.lastSubmittedAt);
  console.log(`📄 ${entries.length} pages au sitemap, ${pages.length} à envoyer${state.lastSubmittedAt && !all ? ` (modifiées depuis le ${state.lastSubmittedAt.slice(0, 10)})` : ''}`);
  if (dryRun || !pages.length) {
    if (dryRun) console.log('🔎 --dry-run : rien envoyé', pages.slice(0, 5));
    return 0;
  }

  const host = new URL(SITE).hostname;
  for (const urlList of chunk(pages)) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host, key, keyLocation: `${SITE}/${key}.txt`, urlList }),
      signal: AbortSignal.timeout(60000)
    });
    // 200: taken; 202: taken, key still being checked
    if (res.status !== 200 && res.status !== 202) {
      throw new Error(`IndexNow HTTP ${res.status} : ${(await res.text()).slice(0, 300)}`);
    }
    console.log(`✅ ${urlList.length} pages envoyées (HTTP ${res.status})`);
  }
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastSubmittedAt: startedAt, lastCount: pages.length }, null, 2));
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error('❌', error.message);
  process.exit(1);
});
