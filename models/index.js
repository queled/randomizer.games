const mongoose = require('mongoose');
const { syncParticipantAccounts } = require('../helpers/participant-accounts');

const gameSchema = new mongoose.Schema({
  // === CORE IDENTITY (YOU control this) ===
  id: { type: String, required: true, unique: true, immutable: true },
  name: { type: String, required: true },
  
  // === OFFICIAL GAME INFO ===
  official: {
    name: String,           // Full official game name
    releaseDate: Date,
    releaseYear: Number,    // Année de sortie (pour affichage)
    website: String
  },
  
  // === RANDOMIZER INFO ===
  randomizer: {
    displayName: String,    // Nom pour affichage
    shortName: String,      // Acronyme
    tinyName: String,       // Très court
    name: String,           // Nom complet
    website: String,        // Site du randomizer
    opensource: Boolean,
    addedDate: Date,        // Date d'ajout du randomizer
    updatedDate: Date       // Dernière mise à jour
  },
  
  // === RESOURCES (Sites, Trackers, Guides, etc.) ===
  resources: {
    // Site officiel principal (défini manuellement si plusieurs URLs)
    officialSite: {
      url: String,
      name: String,
      isArchipelago: { type: Boolean, default: false },
      isMultiworld: { type: Boolean, default: false }
    },
    // Tous les sites du randomizer (depuis rando-list)
    sites: [{
      url: String,
      name: String,
      description: String,
      source: { type: String, enum: ['rando-list', 'manual', 'import', 'community', 'archipelago', 'apworld'], default: 'manual' },
      isArchipelago: { type: Boolean, default: false },
      isMultiworld: { type: Boolean, default: false },
      isObsolete: { type: Boolean, default: false },
      // Community APWorld: its stability in the community list
      apworldStatus: { type: String, enum: ['stable', 'unstable', 'broken'] }
    }],
    // Trackers
    trackers: [{
      url: String,
      name: String,
      description: String,
      translations: { type: mongoose.Schema.Types.Mixed, default: {} },
      source: { type: String, enum: ['manual', 'rando-list', 'import', 'community', 'archipelago', 'apworld'], default: 'manual' }
    }],
    // Guides et tutoriels
    guides: [{
      url: String,
      name: String,
      description: String,
      translations: { type: mongoose.Schema.Types.Mixed, default: {} },
      type: { type: String, enum: ['guide', 'tutorial', 'wiki', 'video'], default: 'guide' },
      source: { type: String, enum: ['manual', 'rando-list', 'import', 'community', 'archipelago', 'apworld'], default: 'manual' }
    }],
    // Autres ressources (Discord, forums, etc.)
    other: [{
      url: String,
      name: String,
      description: String,
      translations: { type: mongoose.Schema.Types.Mixed, default: {} },
      type: { type: String, default: 'resource' },
      source: { type: String, enum: ['manual', 'rando-list', 'import', 'community', 'archipelago', 'apworld'], default: 'manual' }
    }]
  },
  
  // === MEDIA ===
  platforms: [String],
  series: String,           // name of the game series
  
  // === CATEGORIES ===
  // Categories the game is raced in (shown on its Categories tab)
  categories: [{
    id: String,
    name: String,
    description: String,
    translations: { type: mongoose.Schema.Types.Mixed, default: {} }, // { fr: { name, description } }
    // Racetime goals of this category: their races and leaderboards
    racetimeGoals: [{ _id: false, slug: String, goal: String }]
  }],
  // Main settings of the randomizer, shown with the categories
  categorySettings: [{
    _id: false,
    name: String,
    description: String,
    values: [String],
    translations: { type: mongoose.Schema.Types.Mixed, default: {} } // { fr: { name, description } }
  }],
  
  // === EXTERNAL INTEGRATIONS (each source tracked separately) ===
  integrations: {
    randoList: {
      enabled: { type: Boolean, default: false },
      seriesFile: String,           // series file in rando-list
      gameName: String,             // exact name in rando-list
      gameNames: [String],          // other rando-list names of the same game (merged games)
      randomizerIdentifier: String, // identifier in rando-list
      confidence: { type: String, enum: ['manual', 'auto'], default: 'manual' },
      lastSync: Date
    },
    racetime: {
      enabled: { type: Boolean, default: false },
      gameSlug: String,             // slug principal
      gameSlugs: [String],          // slugs additionnels à scanner
      gameName: String,             // display name on racetime
      goalFilters: { type: Map, of: String }, // slug -> regex (case-insensitive) of the goals to import, e.g. { <slug>: "randomizer" }
      confidence: { type: String, enum: ['manual', 'auto'], default: 'manual' },
      lastSync: Date
    },
    speedrun: {
      enabled: { type: Boolean, default: false },
      gameId: String,               // speedrun.com game ID
      weblink: String,              // speedrun.com game page
      confidence: { type: String, enum: ['manual', 'auto'], default: 'manual' },
      lastSync: Date
    },
    twitch: {
      enabled: { type: Boolean, default: false },
      categoryId: String,           // Twitch category ID (game_id)
      categoryName: String,         // Twitch category name
      boxArtUrl: String,            // URL de l'image de la catégorie
      confidence: { type: String, enum: ['manual', 'auto'], default: 'manual' },
      lastSync: Date,
      notFound: { type: Boolean, default: false } // True si pas de catégorie Twitch trouvée
    },
    startgg: {
      enabled: { type: Boolean, default: false },
      videogameId: Number,          // start.gg videogame ID for this game
      searchKeywords: [String],     // Extra keywords to search for this game's tournaments
      confidence: { type: String, enum: ['manual', 'auto'], default: 'manual' },
      lastSync: Date
    },
    challonge: {
      enabled: { type: Boolean, default: false },
      gameId: Number,               // Challonge game_id for this game
      subdomain: String,            // Organisation subdomain, if applicable
      searchKeywords: [String],     // Extra keywords to search for this game's tournaments
      confidence: { type: String, enum: ['manual', 'auto'], default: 'manual' },
      lastSync: Date
    },
    // Game lists of the Archipelago (archipelago.gg) and Multiworld (multiworld.gg)
    // web hosts, kept in sync by scripts/sync-archipelago-games.js
    archipelago: {
      enabled: { type: Boolean, default: false },
      gameName: String,             // name of the world on the site
      confidence: { type: String, enum: ['manual', 'auto'], default: 'manual' },
      lastSync: Date
    },
    multiworld: {
      enabled: { type: Boolean, default: false },
      gameName: String,
      confidence: { type: String, enum: ['manual', 'auto'], default: 'manual' },
      lastSync: Date
    },
    // Community APWorlds list (spreadsheet), kept in sync by scripts/sync-community-apworlds.js
    apworld: {
      enabled: { type: Boolean, default: false },
      gameNames: [String],          // names of the game's rows in the list
      mature: { type: Boolean, default: false }, // flagged 18+ / unrated there
      confidence: { type: String, enum: ['manual', 'auto'], default: 'manual' },
      lastSync: Date
    }
  },
  
  // === METADATA ===
  source: {
    origin: { type: String, enum: ['seed', 'csv-import', 'rando-list', 'manual', 'archipelago', 'apworld', 'randomizer-site'], default: 'manual' },
    importedAt: Date
  },
  enabled: { type: Boolean, default: true }
}, { timestamps: true });

const midosHouseRaceSchema = new mongoose.Schema({
  startggSetId: String,
  startAt: Date,
  round: String,
  // Game number when the set is played over several races
  game: Number,
  entrants: [String],
  roomUrl: String,
  restreams: [{
    _id: false,
    language: String,
    // The channel; the video itself when Mido's House links to a video whose channel is unknown
    url: String,
    // The link as Mido's House gives it (a channel, or a VOD for older events)
    sourceUrl: String,
    // Twitch past broadcast, at the moment the race starts
    vodUrl: String,
    // When Twitch deleted that VOD (the channel stays as who restreamed it)
    vodGoneAt: Date,
    // The YouTube channel's name, its link only giving its id
    channel: String
  }]
}, { _id: false });

const tournamentSchema = new mongoose.Schema({
  challongeId: { type: Number, unique: true, sparse: true },
  name: { type: String, required: true },
  // New relation to internal Game document
  game: { type: mongoose.Schema.Types.ObjectId, ref: 'Game' },
  // Snapshot of game slug/id for quick queries and historic reference
  gameSlug: String,
  // keep legacy field for migration compatibility
  gameId: { type: String, required: false },
  gameName: String,
  url: String,
  fullUrl: String,
  tournamentType: String,
  state: String,
  startDate: Date,
  endDate: Date,
  participantsCount: Number,
  description: String,
  participants: [{
    challongeId: Number,
    name: String,
    seed: Number,
    finalRank: Number,
    displayName: String,
    // Team (start.gg entrant of several players, e.g. co-op) this player raced in
    team: String,
    startggEntrantId: String,
    // start.gg account of the player (same person across tournaments) and the prefix
    // its sets show before the gamer tag ("Prefix | GamerTag")
    startggUserId: String,
    startggUserSlug: String,
    prefix: String,
    // Bracket the participant entered, for tournaments made of several Challonge brackets
    bracketChallongeId: Number,
    // Racetime account that raced the participant's matches (helpers/participant-accounts.js)
    racetimeUserId: String,
    racetimeName: String
  }],
  // Challonge brackets of one tournament stored together (each one is a phase)
  challongeBrackets: [{
    challongeId: Number,
    url: String,
    fullUrl: String,
    name: String,
    label: String,
    tournamentType: String,
    state: String,
    startDate: Date,
    endDate: Date
  }],
  // Matches embedded for start.gg tournaments
  matches: [{
    startggSetId: String,
    round: Number,
    displayScore: String,
    completedAt: Date,
    state: Number,
    phase: String,
    phaseGroup: String,
    raceUrl: String,
    raceUrls: [String],
    linkScore: Number,
    player1: {
      startggEntrantId: String,
      name: String,
      // Players of a team entrant
      members: { type: [String], default: undefined }
    },
    player2: {
      startggEntrantId: String,
      name: String,
      members: { type: [String], default: undefined }
    },
    winnerId: Number,
    // Both players forfeited: start.gg shows a win for one of them (helpers/double-forfeits.js)
    doubleForfeit: Boolean,
    // The next set of that player, lost without playing: the opponent goes through alone
    withdrawnEntrantId: String
  }],
  // Phases for start.gg tournaments
  phases: [{
    startggPhaseId: String,
    name: String,
    bracketType: String,
    phaseOrder: Number,
    numSeeds: Number,
    groupCount: Number,
    state: String
  }],
  setsTotal: Number,
  // External IDs for other platforms (start.gg)
  startggId: Number,
  startggTournamentId: Number,
  startggSlug: String,
  // start.gg bracket of one phase of a tournament rebuilt from elsewhere (Mido's House): a link only
  startggUrl: String,
  // Last refresh from the Challonge API (the update job spaces them out: 500 requests per 30 days)
  challongeSyncedAt: Date,
  // Last race or reported score of a bracket still open: its end for the status while the organizer has not closed it
  lastActivityAt: Date,
  // Participants' finalRank computed from the matches (Challonge gives none before the bracket is closed)
  ranksFromMatches: Boolean,
  // Races scheduled on Mido's House or Hyrule Town Hall (its fork for other
  // games), linked to matches by start.gg set.
  // Kept apart from `matches`, which the start.gg sync rebuilds.
  midosHouse: {
    // 'midos' or 'hth' (services/schedule-sites.js); missing: Mido's House
    site: String,
    series: String,
    event: String,
    url: String,
    lastSync: Date,
    // Upcoming races, replaced on each sync: a race leaves it once played
    schedule: [midosHouseRaceSchema],
    // Played races that were restreamed, kept once the event is over
    pastRestreams: [midosHouseRaceSchema],
    // Start times of the played races, replaced on each sync: places on the calendar
    // the matches played without a racetime.gg race (offline, in person)
    pastStarts: [{
      _id: false,
      startggSetId: String,
      startAt: Date,
      game: Number
    }]
  },
  // Slug of the tournament's SpeedGaming schedule, for an event the speedgaming.org events
  // page does not pair with its bracket (sync-speedgaming.js)
  speedgamingEvent: String,
  // Async series of the tournament on alttprasyncs.com (sync-alttpr-asyncs.js):
  // practice seeds, or qualifiers with their results (live and async together)
  alttprAsyncs: [{
    _id: false,
    seriesId: Number,
    title: String,
    url: String,
    qualifier: Boolean,
    // Linked by hand (--link): kept even when the names no longer match
    manual: Boolean,
    seedCount: Number,
    syncedAt: Date,
    // Qualifier series only
    seeds: [{
      _id: false,
      asyncId: Number,
      createdAt: Date,
      mode: String,
      description: String,
      roomUrl: String,
      participants: Number,
      finishers: Number,
      results: [{
        _id: false,
        place: Number,
        name: String,
        // Seconds
        time: Number,
        forfeit: Boolean,
        vodUrl: String
      }]
    }]
  }],
  // optional source metadata for import tracing
  source: {
    type: { type: String },
    externalId: String,
    tournamentId: String,
    url: String,
    // Several brackets of one tournament share the same group name
    group: String,
    discoveredVia: String,
    importedAt: Date
  }
}, { timestamps: true });

const matchSchema = new mongoose.Schema({
  challongeId: { type: Number, unique: true, sparse: true },
  tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament' },
  tournamentChallongeId: Number,
  state: String,
  groupId: Number,
  // Bracket name when the tournament groups several Challonge brackets
  phase: String,
  identifier: String,
  player1Id: Number,
  player2Id: Number,
  player1Name: String,
  player2Name: String,
  winnerId: Number,
  loserId: Number,
  scoresCsv: String,
  round: Number,
  startedAt: Date,
  completedAt: Date,
  raceUrl: String, // Link to racetime.gg race
  // Completed from its races: the organizer reported the score but never validated the match on Challonge
  settledFromRaces: Boolean,
  // optional source metadata for import tracing
  source: {
    type: { type: String },
    externalId: String,
    url: String,
    importedAt: Date
  }
}, { timestamps: true });

const raceSchema = new mongoose.Schema({
  name: { type: String, required: true },
  category: { type: String, required: true },
  url: { type: String, unique: true },
  status: String,
  goal: String,
  info: { type: String, maxlength: 10000 },
  startedAt: Date,
  endedAt: Date,
  recordable: Boolean,
  tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament' },
  matchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Match' },
  // Start.gg tournament info (when not linked to a specific Match document)
  tournamentPhase: String,  // e.g., "Preliminary Bracket", "Qualifications"
  tournamentPool: String,   // e.g., "1", "2", "A", "B"
  tournamentRound: Number,  // e.g., 1, 2, -1 (negative for losers bracket)
  matchPlayers: String,     // e.g., "PlayerA vs PlayerB"
  // Tie-break room of a group (scripts/auto-link-tournaments.js), no start.gg set
  tiebreak: Boolean,
  startggSetId: String,
  matchConfidence: Number,
  // Twitch VOD of each entrant's own stream (sync-race-vods.js). Kept apart from
  // `entrants`, which the racetime.gg sync rewrites.
  vods: [{
    _id: false,
    userId: String,
    userName: String,
    twitchName: String,
    vodUrl: String,
    // When Twitch deleted that VOD (the channel stays)
    vodGoneAt: Date
  }],
  vodSearchedAt: Date,
  // Restreams found on Twitch (sync-race-restreams.js), for races Mido's House doesn't list:
  // a broadcast of a restreamer whose title names the players
  restreams: [{
    _id: false,
    language: String,
    // The channel
    url: String,
    // Twitch past broadcast at the race start, or a highlight; else the YouTube video
    vodUrl: String,
    title: String,
    // The YouTube channel's name, its link only giving its id
    channel: String,
    vodGoneAt: Date
  }],
  restreamSearchedAt: Date,
  previousMatchCompletedAt: Date,
  entrants: [{
    userId: String,
    userName: String,
    userDiscriminator: String,
    userUrl: String,
    status: String,
    finishTime: String,
    finishTimeMs: Number,
    finishedAt: Date,
    place: Number,
    placeOrdinal: String,
    comment: String
  }],
  // optional normalized source metadata
  source: {
    type: { type: String },
    externalId: String,
    url: String,
    importedAt: Date
  }
}, { timestamps: true });

// Ensure finishTimeMs is populated when possible before saving
function _parseISODuration(str) {
  const cleaned = String(str).replace(/^P(?:\d+D)?T/, 'PT');
  const re = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/;
  const m = re.exec(cleaned);
  if (!m) return null;
  const h = parseInt(m[1] || 0, 10);
  const min = parseInt(m[2] || 0, 10);
  const s = parseFloat(m[3] || 0);
  return Math.round(((h * 3600) + (min * 60) + s) * 1000);
}

function _parseTimeToMs(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  const s = String(value).trim();
  if (!s) return null;
  if (s.startsWith('PT') || s.startsWith('P')) return _parseISODuration(s);
  if (s.includes(':')) {
    const parts = s.split(':').map(p => parseFloat(p));
    if (parts.length === 3) return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
    if (parts.length === 2) return Math.round((parts[0] * 60 + parts[1]) * 1000);
  }
  const num = Number(s);
  if (!Number.isNaN(num)) {
    if (num > 10000) return Math.round(num);
    return Math.round(num * 1000);
  }
  return null;
}

raceSchema.pre('save', function() {
  if (Array.isArray(this.entrants)) {
    for (const ent of this.entrants) {
      if ((ent.finishTime || ent.finishTime === 0) && !ent.finishTimeMs) {
        const ms = _parseTimeToMs(ent.finishTime);
        if (ms != null) ent.finishTimeMs = ms;
      }
    }
  }
});

const playerSchema = new mongoose.Schema({
  userId: { type: String, unique: true },
  name: { type: String, required: true },
  discriminator: String,
  racetimeUrl: String,
  // External identifiers / social handles
  racetimeId: String,
  twitch: String,
  challongeUrl: String,
  // Alternate names (e.g. Challonge/start.gg participant names) for this player
  aliases: { type: [String], default: [] },
  // Last read of the racetime.gg profile (scripts/sync-racetime-profiles.js), and when
  // racetime stopped knowing the account: a deleted account leaves the player lists
  racetimeCheckedAt: Date,
  racetimeDeletedAt: Date,
  // racetime.gg avatar (null: the account has none) and when it was last read, so a
  // new avatar shows up within hours (services/racetime-profile.js)
  avatarUrl: String,
  avatarCheckedAt: Date,
  tournaments: [{
    tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament' },
    finalRank: Number,
    participatedAt: Date
  }],
  stats: {
    totalRaces: { type: Number, default: 0 },
    totalWins: { type: Number, default: 0 },
    bestTime: String,
    bestTimeMs: Number,
    averageTime: String,
    averageTimeMs: Number
  }
}, { timestamps: true });

// Ensure player stats ms values are populated before saving
// Participants rewritten by an import or a sync: their racetime accounts again
tournamentSchema.post('findOneAndUpdate', async function() {
  const update = this.getUpdate() || {};
  if (!(update.$set || update).participants) return;
  try {
    const tournament = await this.model.findOne(this.getQuery());
    if (tournament) await syncParticipantAccounts({ tournament, Race: mongoose.model('Race') });
  } catch (error) {
    console.error(`Racetime accounts of the participants: ${error.message}`);
  }
});

playerSchema.pre('save', function() {
  if (this.stats) {
    if ((this.stats.bestTime || this.stats.bestTime === 0) && !this.stats.bestTimeMs) {
      const ms = _parseTimeToMs(this.stats.bestTime);
      if (ms != null) this.stats.bestTimeMs = ms;
    }
    if ((this.stats.averageTime || this.stats.averageTime === 0) && !this.stats.averageTimeMs) {
      const ms = _parseTimeToMs(this.stats.averageTime);
      if (ms != null) this.stats.averageTimeMs = ms;
    }
  }
});

// Challonge bracket links the speedgaming.org discovery rejected (not a randomizer,
// private bracket...), so it does not spend API requests on them every day
const discoverySkipSchema = new mongoose.Schema({
  url: { type: String, required: true, unique: true },
  title: String,
  reason: String,
  checkedAt: Date
});

// YouTube channels that archive restreams (scripts/discover-youtube-restreamers.js):
// a channel is kept once its uploads are restreams of races in the base
const youtubeChannelSchema = new mongoose.Schema({
  channelId: { type: String, required: true, unique: true },
  title: String,
  handle: String,
  // The Twitch channel it archives, and the language it restreams in
  twitchLogin: String,
  language: String,
  // manual (set by hand), midos (videos Mido's House links), handle (same name as a Twitch restreamer), search (YouTube search)
  source: String,
  status: { type: String, enum: ['accepted', 'rejected'] },
  matchedRaces: Number,
  validatedAt: Date
});

// YouTube searches already made by the discovery, not repeated
const youtubeSearchSchema = new mongoose.Schema({
  query: { type: String, required: true, unique: true },
  tournamentId: mongoose.Schema.Types.ObjectId,
  videos: [{ _id: false, videoId: String, channelId: String }],
  searchedAt: Date
});

// Indexes for better query performance
tournamentSchema.index({ gameId: 1, startDate: -1 });
// consider also indexing new relation
tournamentSchema.index({ game: 1, startDate: -1 });
matchSchema.index({ tournamentId: 1 });
raceSchema.index({ tournamentId: 1 });
raceSchema.index({ category: 1, startedAt: -1 });
// Add composite index for live queries
raceSchema.index({ status: 1, startedAt: -1 });
raceSchema.index({ 'vods.vodUrl': 1 }, { sparse: true });
// Races of a player (player page, comparison, search) and the plain race list
raceSchema.index({ 'entrants.userId': 1, startedAt: -1 });
raceSchema.index({ 'entrants.userName': 1 });
raceSchema.index({ startedAt: -1 });
playerSchema.index({ name: 1 });
playerSchema.index({ aliases: 1 });

// Randomizer runs of speedrun marathons (scripts/sync-gdq-runs.js), shown on the game page
const marathonRunSchema = new mongoose.Schema({
  // 'gdq'
  source: { type: String, required: true },
  // The run's id at the source
  externalId: { type: String, required: true },
  event: { short: String, name: String },
  game: { type: mongoose.Schema.Types.ObjectId, ref: 'Game' },
  gameSlug: String,
  // Game and category as the marathon names them
  name: String,
  category: String,
  runners: [String],
  startedAt: Date,
  // Seconds
  runTime: Number,
  videos: [{ _id: false, type: { type: String }, url: String }]
}, { timestamps: true });
marathonRunSchema.index({ source: 1, externalId: 1 }, { unique: true });
marathonRunSchema.index({ gameSlug: 1, startedAt: -1 });

// Admin sessions, kept in the database so a restart does not log the admin out.
// Only a hash of the session token is stored; MongoDB drops expired sessions.
const adminSessionSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },
  adminId: { type: String, default: 'admin' },
  expiresAt: { type: Date, required: true }
}, { timestamps: { createdAt: true, updatedAt: false } });
adminSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = {
  Game: mongoose.model('Game', gameSchema),
  Tournament: mongoose.model('Tournament', tournamentSchema),
  Match: mongoose.model('Match', matchSchema),
  Race: mongoose.model('Race', raceSchema),
  Player: mongoose.model('Player', playerSchema),
  DiscoverySkip: mongoose.model('DiscoverySkip', discoverySkipSchema),
  MarathonRun: mongoose.model('MarathonRun', marathonRunSchema),
  AdminSession: mongoose.model('AdminSession', adminSessionSchema),
  YoutubeChannel: mongoose.model('YoutubeChannel', youtubeChannelSchema),
  YoutubeSearch: mongoose.model('YoutubeSearch', youtubeSearchSchema)
};
