#!/usr/bin/env node
/**
 * Merge Challonge tournaments that are brackets of one event into a single tournament
 * (each bracket becomes a phase). Races linked to the brackets follow.
 *
 * Usage:
 *   node scripts/merge-challonge-brackets.js --group "A Link To The Past Randomizer Spoiler Log Tournament" --dry-run
 *   node scripts/merge-challonge-brackets.js --all-groups            # every source.group shared by several brackets
 *   node scripts/merge-challonge-brackets.js --ids <id1>,<id2> --name "Event name"
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Tournament, Match, Race } = require('../models');
const challongeAPI = require('../services/challonge');
const { deriveBracketLabels, saveGroupedChallongeBracket } = require('../services/challonge-bracket-groups');

function parseArgs() {
  const args = process.argv.slice(2);
  const value = flag => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
  return {
    dryRun: args.includes('--dry-run'),
    allGroups: args.includes('--all-groups'),
    group: value('--group'),
    ids: (value('--ids') || '').split(',').map(s => s.trim()).filter(Boolean),
    name: value('--name')
  };
}

async function findGroups(opts) {
  if (opts.ids.length) {
    if (!opts.name) throw new Error('--name is required with --ids');
    return [{ group: opts.name, tournaments: await Tournament.find({ _id: { $in: opts.ids } }).sort({ createdAt: 1 }).lean() }];
  }

  const groupNames = opts.group
    ? [opts.group]
    : await Tournament.distinct('source.group', { 'source.group': { $ne: null } });

  const groups = [];
  for (const group of groupNames) {
    const tournaments = await Tournament.find({ 'source.group': group, challongeId: { $ne: null } }).sort({ createdAt: 1 }).lean();
    // Something left to merge: several documents for the group, one of them not grouped yet
    if (tournaments.length > 1 && tournaments.some(t => !t.challongeBrackets?.length)) {
      groups.push({ group, tournaments });
    }
  }
  return groups;
}

async function main() {
  const opts = parseArgs();
  if (!opts.allGroups && !opts.group && !opts.ids.length) {
    console.log('Usage: --group "<name>" | --all-groups | --ids <id1>,<id2> --name "<name>" [--dry-run]');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const groups = await findGroups(opts);
  if (!groups.length) console.log('Aucun groupe de brackets à fusionner');

  for (const { group, tournaments } of groups) {
    const brackets = tournaments.flatMap(t => (t.challongeBrackets?.length
      ? t.challongeBrackets.map(b => ({ challongeId: b.challongeId, url: b.url, name: b.name, label: b.label, from: t }))
      : [{ challongeId: t.challongeId, url: t.url, name: t.name, label: null, from: t }]));
    const labels = deriveBracketLabels(brackets.map(b => b.name));

    console.log(`\n🧩 ${group}`);
    brackets.forEach((b, i) => console.log(`   • ${b.name} → phase "${b.label || labels[i]}" (${b.from._id})`));
    if (opts.dryRun) continue;

    for (const bracket of brackets) {
      const challongeId = bracket.url || String(bracket.challongeId);
      const tournamentData = await challongeAPI.getTournament(challongeId);
      const participants = await challongeAPI.getParticipants(challongeId);
      const matches = await challongeAPI.getMatches(challongeId);
      const { game, gameSlug, gameName, description, source } = bracket.from;
      const { tournament, phaseName } = await saveGroupedChallongeBracket(
        { Tournament, Match, Race },
        {
          group,
          label: bracket.label,
          tournamentData,
          participants,
          matches,
          payload: { game, gameSlug, gameName, description, source: { discoveredVia: source?.discoveredVia || null } }
        }
      );
      console.log(`   ✅ ${bracket.name} → ${tournament._id} / ${phaseName} (${matches.length} matches)`);
    }
  }

  await mongoose.disconnect();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
