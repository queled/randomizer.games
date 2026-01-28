#!/usr/bin/env node
// Usage: node scripts/backfill-populate-source.js [--apply]
require('dotenv').config();
const mongoose = require('mongoose');
const { Race, Match } = require('../models');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer';
const apply = process.argv.includes('--apply');

function deriveRaceSource(r) {
  const url = r.url || '';
  try {
    // racetime urls either full https://racetime.gg/category/id or short /category/id
    if (/racetime\.gg/.test(url) || /^\/?[a-z0-9-]+\/[a-z0-9-]+$/i.test(url)) {
      const parts = url.replace(/^https?:\/\/(www\.)?racetime.gg/, '').replace(/^\/+/, '').split('/').filter(Boolean);
      if (parts.length >= 2) return { type: 'racetime', externalId: parts[1], url: url, importedAt: new Date() };
    }
    // fallback: if it contains challonge
    if (/challonge/.test(url)) {
      // try to extract trailing id
      const m = url.match(/challonge\.com\/(.+)$/i);
      if (m) return { type: 'challonge', externalId: m[1].replace(/\/.*/,'').trim(), url: url, importedAt: new Date() };
    }
  } catch (e) { /* ignore */ }
  return null;
}

function deriveMatchSource(m) {
  if (m.source && m.source.type) return null;
  if (m.challongeId) return { type: 'challonge', externalId: String(m.challongeId), url: null, importedAt: new Date() };
  if (m.raceUrl) {
    const parts = (m.raceUrl || '').replace(/^https?:\/\/(www\.)?racetime.gg/, '').replace(/^\/+/, '').split('/').filter(Boolean);
    if (parts.length >= 2) return { type: 'racetime', externalId: parts[1], url: m.raceUrl, importedAt: new Date() };
  }
  return null;
}

async function run() {
  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log('Connected to', MONGODB_URI);

  const races = await Race.find({ $or: [ { source: { $exists: false } }, { 'source.type': { $exists: false } }, { 'source.type': null } ] }).limit(1000).lean();
  console.log('Races missing source found:', races.length);
  const raceChanges = [];
  for (const r of races) {
    const src = deriveRaceSource(r);
    if (src) raceChanges.push({ _id: r._id, url: r.url, source: src });
  }

  const matches = await Match.find({ $or: [ { source: { $exists: false } }, { 'source.type': { $exists: false } }, { 'source.type': null } ] }).limit(1000).lean();
  console.log('Matches missing source found:', matches.length);
  const matchChanges = [];
  for (const m of matches) {
    const src = deriveMatchSource(m);
    if (src) matchChanges.push({ _id: m._id, challongeId: m.challongeId, raceUrl: m.raceUrl, source: src });
  }

  console.log('\nProposed Race updates:', raceChanges.length);
  raceChanges.slice(0,20).forEach(c => console.log('-', c._id.toString(), c.url, '->', c.source.type, c.source.externalId));

  console.log('\nProposed Match updates:', matchChanges.length);
  matchChanges.slice(0,20).forEach(c => console.log('-', c._id.toString(), c.challongeId || c.raceUrl, '->', c.source.type, c.source.externalId));

  if (!apply) {
    console.log('\nDry-run complete. Rerun with --apply to write changes.');
    await mongoose.disconnect();
    return;
  }

  console.log('\nApplying updates...');
  for (const c of raceChanges) {
    await Race.updateOne({ _id: c._id }, { $set: { source: c.source }, $currentDate: { updatedAt: true } });
  }
  for (const c of matchChanges) {
    await Match.updateOne({ _id: c._id }, { $set: { source: c.source }, $currentDate: { updatedAt: true } });
  }

  console.log('Applied', raceChanges.length, 'race updates and', matchChanges.length, 'match updates.');
  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
