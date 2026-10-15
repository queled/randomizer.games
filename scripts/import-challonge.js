// Usage: node scripts/import-challonge.js <challongeIdOrUrl>
// Example: node scripts/import-challonge.js MMRSeason6

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const connectDB = require('../config/database');
const sanitizeHtml = require('sanitize-html');
const challonge = require('../services/challonge');
const findGameForTournament = require('../helpers/findGameForTournament');
const { fillMissingFinalRanks } = require('../helpers/bracket-ranks');

function parseChallongeId(input){
  if(!input) return null;
  try{
    const url = new URL(input);
    // challonge URLs are like https://challonge.com/fr/MMRSeason6 or /MMRSeason6
    const parts = url.pathname.split('/').filter(Boolean);
    if(parts.length) return parts[parts.length-1];
    return null;
  }catch(e){
    // not a URL, return input as-is
    return input;
  }
}

async function main(){
  const args = process.argv.slice(2);
  if(!args[0]){
    console.error('challonge id or url required');
    process.exit(1);
  }
  const raw = args[0];
  const challongeId = parseChallongeId(raw);
  if(!challongeId){ console.error('Unable to parse Challonge id'); process.exit(1); }

  await connectDB();
  const { Tournament, Match } = require('../models');

  console.log('Fetching tournament from Challonge:', challongeId);
  const details = await challonge.getTournamentDetails(challongeId);
  const { tournamentData, matches } = details;
  if(!tournamentData){ console.error('No tournament data returned'); process.exit(1); }

  // Ranks of the played bracket while the organizer has not finalized it
  const participants = fillMissingFinalRanks({ tournamentData, participants: details.participants, matches });

  // Determine game mapping
  const matchForGame = await findGameForTournament({
    providedGameSlug: null,
    providedGameId: tournamentData.gameId,
    tournamentName: tournamentData.name,
    tournamentDescription: tournamentData.description
  });

  const cleanDescription = tournamentData.description ? sanitizeHtml(tournamentData.description, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([ 'img', 'br' ]),
    allowedAttributes: {
      a: [ 'href', 'name', 'target', 'rel' ],
      img: [ 'src', 'alt', 'title', 'width', 'height' ]
    },
    allowedSchemesByTag: {
      a: [ 'http', 'https', 'mailto' ],
      img: [ 'http', 'https', 'data' ]
    }
  }) : null;

  const tournamentPayload = {
    name: tournamentData.name,
    challongeId: tournamentData.id,
    url: tournamentData.url,
    fullUrl: tournamentData.fullUrl,
    tournamentType: tournamentData.tournamentType,
    state: tournamentData.state,
    participantsCount: tournamentData.participantsCount,
    description: cleanDescription,
    participants: participants,
    startDate: tournamentData.startedAt,
    endDate: tournamentData.completedAt,
    gameName: tournamentData.gameName,
    source: { type: 'challonge', externalId: String(tournamentData.id), url: tournamentData.fullUrl || tournamentData.url || null, importedAt: new Date() }
  };

  if(matchForGame){
    tournamentPayload.game = matchForGame.gameId;
    tournamentPayload.gameSlug = matchForGame.gameSlug;
  } else if(tournamentData.gameId){
    tournamentPayload.gameId = tournamentData.gameId;
  }

  // Upsert tournament
  const tournament = await Tournament.findOneAndUpdate(
    { challongeId: tournamentData.id },
    { $set: tournamentPayload, $currentDate: { updatedAt: true } },
    { upsert: true, new: true }
  );

  console.log('Tournament saved:', tournament._id.toString(), tournament.name);

  // Build participant map (handle group player ids)
  const participantMap = new Map();
  participants.forEach(p => {
    participantMap.set(p.challongeId, p);
    if(p.groupPlayerIds && Array.isArray(p.groupPlayerIds)){
      p.groupPlayerIds.forEach(gid => participantMap.set(gid, p));
    }
  });

  // Upsert matches
  for(const m of matches){
    const player1 = participantMap.get(m.player1Id) || null;
    const player2 = participantMap.get(m.player2Id) || null;

    await Match.findOneAndUpdate(
      { challongeId: m.id },
      { $set: {
        ...m,
        tournamentId: tournament._id,
        tournamentChallongeId: tournament.challongeId,
        player1Name: player1 ? (player1.displayName || player1.name) : null,
        player2Name: player2 ? (player2.displayName || player2.name) : null
      }, $currentDate: { updatedAt: true } },
      { upsert: true }
    );
  }

  console.log('Matches upserted:', matches.length);

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
