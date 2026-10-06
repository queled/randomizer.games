/**
 * Several Challonge brackets of one tournament (e.g. "Upper", "Middle" and "Lower"
 * brackets of the same event) are stored as a single Tournament: each bracket is a
 * phase, its matches carry the phase name, and the source brackets are kept in
 * `challongeBrackets` so imports and syncs refresh the right one.
 */

const COMPLETE_STATES = ['complete', 'completed', 'awaiting_review'];

function tokens(name) {
  return String(name || '').split(/\s+/).filter(Boolean);
}

/**
 * Phase name of a bracket: the words its name does not share with its siblings
 * ("2026 Spoiler Tournament Upper Bracket" + "... Lower Bracket" → "Upper", "Lower").
 */
function deriveBracketLabels(names) {
  if (names.length < 2) return names.map(name => name);
  const shared = tokens(names[0]).map(t => t.toLowerCase())
    .filter(token => names.every(name => tokens(name).some(t => t.toLowerCase() === token)));
  return names.map(name => {
    const label = tokens(name).filter(t => !shared.includes(t.toLowerCase())).join(' ');
    return label || name;
  });
}

function aggregateState(brackets) {
  const states = brackets.map(b => String(b.state || '').toLowerCase());
  if (states.every(state => COMPLETE_STATES.includes(state))) return 'complete';
  if (states.every(state => state === 'pending')) return 'pending';
  return 'underway';
}

/**
 * Save one Challonge bracket into the Tournament of its group, creating it if needed.
 * `bracket` holds the data fetched from Challonge; `payload` the fields the caller
 * computed for a standalone import (game, description...).
 */
async function saveGroupedChallongeBracket({ Tournament, Match, Race }, { group, label = null, tournamentData, participants, matches, payload = {} }) {
  const challongeId = Number(tournamentData.id);
  // The bracket's own standalone import, if any, becomes the group (challongeId is unique)
  const parent = await Tournament.findOne({ 'challongeBrackets.challongeId': challongeId }) ||
    await Tournament.findOne({ 'source.group': group, 'challongeBrackets.0': { $exists: true } }) ||
    await Tournament.findOne({ challongeId });

  const entry = {
    challongeId,
    url: tournamentData.url,
    fullUrl: tournamentData.fullUrl,
    name: tournamentData.name,
    label,
    tournamentType: tournamentData.tournamentType,
    state: tournamentData.state,
    startDate: tournamentData.startedAt || null,
    endDate: tournamentData.completedAt || null
  };

  const brackets = (parent?.challongeBrackets || []).map(b => (b.toObject ? b.toObject() : b));
  const index = brackets.findIndex(b => Number(b.challongeId) === challongeId);
  if (index >= 0) brackets[index] = { ...brackets[index], ...entry, label: label || brackets[index].label };
  else brackets.push(entry);

  // Brackets without an explicit label are named after what sets their name apart from
  // their siblings, recomputed as brackets join the group
  const derived = deriveBracketLabels(brackets.map(b => b.name));
  const phaseNames = brackets.map((b, i) => b.label || derived[i]);
  const phaseName = phaseNames[brackets.findIndex(b => Number(b.challongeId) === challongeId)];

  const otherParticipants = (parent?.participants || [])
    .map(p => (p.toObject ? p.toObject() : p))
    .filter(p => p.bracketChallongeId != null && Number(p.bracketChallongeId) !== challongeId);
  const bracketParticipants = participants.map(p => ({ ...p, bracketChallongeId: challongeId }));

  const startDates = brackets.map(b => b.startDate).filter(Boolean).map(d => new Date(d).getTime());
  const endDates = brackets.map(b => b.endDate).filter(Boolean).map(d => new Date(d).getTime());
  const state = aggregateState(brackets);
  const types = [...new Set(brackets.map(b => b.tournamentType).filter(Boolean))];
  const first = brackets[0];

  const groupPayload = {
    ...payload,
    name: group,
    challongeId: Number(first.challongeId),
    url: first.url,
    fullUrl: first.fullUrl,
    tournamentType: types.length === 1 ? types[0] : (parent?.tournamentType || tournamentData.tournamentType),
    state,
    participants: [...otherParticipants, ...bracketParticipants],
    participantsCount: otherParticipants.length + bracketParticipants.length,
    startDate: startDates.length ? new Date(Math.min(...startDates)) : null,
    endDate: state === 'complete' && endDates.length ? new Date(Math.max(...endDates)) : null,
    challongeBrackets: brackets,
    phases: brackets.map((b, i) => ({ name: phaseNames[i], bracketType: b.tournamentType, phaseOrder: i + 1, state: b.state })),
    source: {
      ...(parent?.source?.toObject ? parent.source.toObject() : parent?.source || {}),
      ...(payload.source || {}),
      type: 'challonge',
      externalId: String(first.challongeId),
      url: first.fullUrl || null,
      group,
      importedAt: new Date()
    }
  };

  const tournament = parent
    ? await Tournament.findByIdAndUpdate(parent._id, { $set: groupPayload, $currentDate: { updatedAt: true } }, { new: true })
    : await Tournament.create(groupPayload);

  // A bracket imported on its own before being grouped: hand its races over, then drop it
  const standalone = await Tournament.find({ challongeId, _id: { $ne: tournament._id } }).select('_id').lean();
  for (const old of standalone) {
    await Race.updateMany({ tournamentId: old._id }, { $set: { tournamentId: tournament._id } });
    await Tournament.deleteOne({ _id: old._id });
  }

  const participantMap = new Map();
  participants.forEach(p => {
    participantMap.set(p.challongeId, p);
    (p.groupPlayerIds || []).forEach(gid => participantMap.set(gid, p));
  });

  for (const m of matches) {
    const player1 = participantMap.get(m.player1Id) || null;
    const player2 = participantMap.get(m.player2Id) || null;
    await Match.findOneAndUpdate(
      { challongeId: m.id },
      {
        $set: {
          ...m,
          tournamentId: tournament._id,
          tournamentChallongeId: challongeId,
          phase: phaseName,
          player1Name: player1 ? (player1.displayName || player1.name) : null,
          player2Name: player2 ? (player2.displayName || player2.name) : null,
          source: { type: 'challonge', externalId: String(m.id), importedAt: new Date() }
        },
        $currentDate: { updatedAt: true }
      },
      { upsert: true }
    );
  }

  // Sibling brackets may have been renamed by this one joining the group
  for (const [i, b] of brackets.entries()) {
    if (Number(b.challongeId) === challongeId) continue;
    await Match.updateMany({ tournamentChallongeId: Number(b.challongeId) }, { $set: { tournamentId: tournament._id, phase: phaseNames[i] } });
  }

  return { tournament, phaseName };
}

module.exports = {
  deriveBracketLabels,
  saveGroupedChallongeBracket
};
