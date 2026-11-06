#!/usr/bin/env node
/**
 * Restreams of marathon randomizer runs in another language
 *
 * Some channels restream the GDQ marathons in their language and archive each run on
 * YouTube, tagged with the marathon ("[SGDQ2030]"). The randomizer runs among them go
 * to the run in `marathonruns` (helpers/marathon-restreams.js), in `restreams`, which
 * scripts/sync-gdq-runs.js leaves alone. 1 unit for 50 uploads.
 *
 * Usage:
 *   node scripts/sync-marathon-restreams.js              # uploads of the last 400 days
 *   node scripts/sync-marathon-restreams.js --all        # every upload (one-off backfill)
 *   node scripts/sync-marathon-restreams.js --dry-run
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const connectDB = require('../config/database');
const { MarathonRun } = require('../models');
const youtube = require('../services/youtube');
const { matchRestream, titleEvent, RANDOMIZER_RE } = require('../helpers/marathon-restreams');

// YouTube handle → language of its restreams
const CHANNELS = [
  { handle: 'LeFrenchRestream', language: 'fr' }
];
// Marathons upload weeks later; restreamers too
const RECENT_DAYS = 400;

function parseArgs() {
  const args = process.argv.slice(2);
  return { dryRun: args.includes('--dry-run'), all: args.includes('--all') };
}

async function main() {
  const opts = parseArgs();
  if (!youtube.hasKey()) {
    console.log('YOUTUBE_API_KEY manquant : rien à faire');
    return;
  }
  if (opts.dryRun) console.log('📋 Mode DRY-RUN : rien n\'est enregistré');
  await connectDB();
  const runs = await MarathonRun.find().select('_id event name category runTime restreams').lean();
  const known = new Set(runs.map(r => String(r.event && r.event.short).toLowerCase()));
  const since = opts.all ? new Date(0) : new Date(Date.now() - RECENT_DAYS * 24 * 3600 * 1000);
  const stats = { videos: 0, randomizer: 0, matched: 0, added: 0, otherMarathon: 0, unmatched: 0 };

  for (const { handle, language } of CHANNELS) {
    const channel = await youtube.getChannelByHandle(handle);
    if (!channel) { console.log(`❓ @${handle} : chaîne introuvable`); continue; }
    let uploads;
    try {
      uploads = await youtube.getUploads(channel, since);
    } catch (error) {
      if (youtube.isQuotaError(error)) { console.log('   ⏸️  Quota YouTube atteint : la suite au prochain passage'); break; }
      throw error;
    }
    stats.videos += uploads.length;
    for (const video of uploads) {
      const title = video.snippet.title;
      if (!RANDOMIZER_RE.test(title)) continue;
      stats.randomizer++;
      const run = matchRestream(title, runs);
      if (!run) {
        // A marathon the site does not list (not GDQ) is expected; one it lists is worth a look
        if (known.has(titleEvent(title))) { stats.unmatched++; console.log(`   ❔ sans run : « ${title} »`); } else stats.otherMarathon++;
        continue;
      }
      stats.matched++;
      const url = `https://www.youtube.com/watch?v=${video.id}`;
      if ((run.restreams || []).some(r => r.url === url)) continue;
      stats.added++;
      console.log(`   ▶️  ${run.event.short} ${run.name} — ${run.category} : ${channel.title} (${language}) « ${title} »`);
      if (!opts.dryRun) {
        await MarathonRun.updateOne({ _id: run._id }, { $push: { restreams: { language, url, channel: channel.title } } });
      }
      run.restreams = [...(run.restreams || []), { url }];
    }
  }

  console.log('\n📊 Restreams de marathons');
  console.log(`Vidéos lues : ${stats.videos}, dont ${stats.randomizer} de randomizer`);
  console.log(`Rattachées à une run : ${stats.matched} (${stats.added} nouvelles)`);
  console.log(`Autres marathons : ${stats.otherMarathon} ; sans run trouvée : ${stats.unmatched}`);
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error.response && error.response.data ? JSON.stringify(error.response.data.error) : error);
  await mongoose.disconnect();
  process.exit(1);
});
