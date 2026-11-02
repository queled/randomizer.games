#!/usr/bin/env node
/**
 * Takes the audience back from the Nginx logs, for the days before the pages
 * reported their own views (routes/audience.js).
 *
 * Only the browsers that ran the page count, as with the live measure: a page
 * is kept when the same address and browser also called the API that day (the
 * site sends no Referer, so the logs cannot tell which page made the call). Views already taken from the logs are replaced, so the
 * import can be run again.
 *
 * The logs are only readable by root, the app by its own user:
 *   zcat -f /var/log/nginx/access.log.* /var/log/nginx/access.log \
 *     | sudo -u randomizer node scripts/import-audience-logs.js [--dry-run]
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const readline = require('readline');
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const { PageView } = require('../models');
const { describeView, dayOf } = require('../services/audience');

const DRY_RUN = process.argv.includes('--dry-run');
const SITE_HOST = new URL(process.env.SITE_URL || 'https://randomizer.games').host;

// Nginx "combined" format
const LINE = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+) [^"]*" (\d{3}) \S+ "([^"]*)" "([^"]*)"/;
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// "02/Nov/2026:19:50:00 +0100"
function parseTime(value) {
  const m = value.match(/^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/);
  if (!m) return null;
  const offset = (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]));
  return new Date(Date.UTC(Number(m[3]), MONTHS[m[2]], Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) - offset * 60000);
}

function parseLine(line) {
  const m = line.match(LINE);
  if (!m) return null;
  const at = parseTime(m[2]);
  if (!at) return null;
  return { ip: m[1], at, method: m[3], url: m[4], status: Number(m[5]), referrer: m[6] === '-' ? '' : m[6], userAgent: m[7] };
}

async function main() {
  await connectDB();

  // The live measure takes over from its first view
  const firstLive = await PageView.findOne({ source: 'browser' }).sort({ at: 1 }).select('at').lean();
  const until = firstLive?.at || new Date();

  const pages = [];
  const ranScripts = new Set();
  let lines = 0;
  for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    lines++;
    const entry = parseLine(line);
    if (!entry || entry.method !== 'GET' || entry.at >= until) continue;
    const key = `${dayOf(entry.at)}|${entry.ip}|${entry.userAgent}`;
    if (entry.url.startsWith('/api/')) {
      ranScripts.add(key);
    } else if (entry.status === 200 || entry.status === 304) {
      pages.push({ ...entry, key });
    }
  }

  // The logs list the files in any order: the views are hashed day by day
  pages.sort((a, b) => a.at - b.at);
  const views = [];
  for (const entry of pages) {
    if (!ranScripts.has(entry.key)) continue;
    const view = await describeView({
      pathname: entry.url,
      referrer: entry.referrer,
      ip: entry.ip,
      userAgent: entry.userAgent,
      at: entry.at,
      siteHost: SITE_HOST,
      source: 'logs'
    });
    if (view) views.push(view);
  }

  const byDay = {};
  for (const view of views) byDay[dayOf(view.at)] = (byDay[dayOf(view.at)] || 0) + 1;
  console.log(`${lines} lignes lues, ${pages.length} pages servies, ${views.length} vues gardées (avant ${until.toISOString()})`);
  for (const [day, count] of Object.entries(byDay)) console.log(`  ${day} : ${count} vues`);

  if (!DRY_RUN) {
    const { deletedCount } = await PageView.deleteMany({ source: 'logs' });
    if (views.length) await PageView.insertMany(views, { ordered: false });
    console.log(`${deletedCount} vues reprises des logs remplacées par ${views.length}`);
  } else {
    console.log('Simulation : rien n’a été écrit');
  }
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});
