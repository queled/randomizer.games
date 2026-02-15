const mongoose = require('mongoose');

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
    displayName: String,    // Nom pour affichage (ex: "A Link to the Past Randomizer")
    shortName: String,      // Acronyme (ex: "ALttP Randomizer")
    tinyName: String,       // Très court (ex: "ALttPR", "OoTR")
    name: String,           // Nom complet (ex: "The Legend of Zelda: A Link to the Past Randomizer")
    website: String,        // Site du randomizer (ex: "https://alttpr.com")
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
      isArchipelago: { type: Boolean, default: false }
    },
    // Tous les sites du randomizer (depuis rando-list)
    sites: [{
      url: String,
      name: String,
      description: String,
      source: { type: String, enum: ['rando-list', 'manual', 'import', 'community'], default: 'manual' },
      isArchipelago: { type: Boolean, default: false },
      isObsolete: { type: Boolean, default: false }
    }],
    // Trackers
    trackers: [{
      url: String,
      name: String,
      description: String,
      translations: { type: mongoose.Schema.Types.Mixed, default: {} },
      source: { type: String, enum: ['manual', 'rando-list', 'import', 'community'], default: 'manual' }
    }],
    // Guides et tutoriels
    guides: [{
      url: String,
      name: String,
      description: String,
      translations: { type: mongoose.Schema.Types.Mixed, default: {} },
      type: { type: String, enum: ['guide', 'tutorial', 'wiki', 'video'], default: 'guide' },
      source: { type: String, enum: ['manual', 'rando-list', 'import', 'community'], default: 'manual' }
    }],
    // Autres ressources (Discord, forums, etc.)
    other: [{
      url: String,
      name: String,
      description: String,
      translations: { type: mongoose.Schema.Types.Mixed, default: {} },
      type: { type: String, default: 'resource' },
      source: { type: String, enum: ['manual', 'rando-list', 'import', 'community'], default: 'manual' }
    }]
  },
  
  // === MEDIA ===
  platforms: [String],
  logo: String,
  image: String,
  series: String,           // e.g. "Zelda Series"
  
  // === CATEGORIES ===
  categories: [{
    id: String,
    name: String,
    description: String
  }],
  
  // === EXTERNAL INTEGRATIONS (each source tracked separately) ===
  integrations: {
    randoList: {
      enabled: { type: Boolean, default: false },
      seriesFile: String,           // e.g. "The_Legend_of_Zelda.yml"
      gameName: String,             // exact name in rando-list
      randomizerIdentifier: String, // identifier in rando-list
      confidence: { type: String, enum: ['manual', 'auto'], default: 'manual' },
      lastSync: Date
    },
    racetime: {
      enabled: { type: Boolean, default: false },
      gameSlug: String,             // e.g. "ootr", "alttpr" (slug principal)
      gameSlugs: [String],          // e.g. ["alttpr", "alttpr-ladder"] (slugs additionnels à scanner)
      gameName: String,             // display name on racetime
      confidence: { type: String, enum: ['manual', 'auto'], default: 'manual' },
      lastSync: Date
    },
    speedrun: {
      enabled: { type: Boolean, default: false },
      gameId: String,               // speedrun.com game ID
      weblink: String,              // e.g. "https://www.speedrun.com/alttp"
      confidence: { type: String, enum: ['manual', 'auto'], default: 'manual' },
      lastSync: Date
    },
    twitch: {
      enabled: { type: Boolean, default: false },
      categoryId: String,           // Twitch category ID (game_id)
      categoryName: String,         // Twitch category name (e.g. "The Legend of Zelda: A Link to the Past")
      boxArtUrl: String,            // URL de l'image de la catégorie
      confidence: { type: String, enum: ['manual', 'auto'], default: 'manual' },
      lastSync: Date,
      notFound: { type: Boolean, default: false } // True si pas de catégorie Twitch trouvée
    }
  },
  
  // === METADATA ===
  source: {
    origin: { type: String, enum: ['seed', 'csv-import', 'rando-list', 'manual'], default: 'manual' },
    importedAt: Date
  },
  enabled: { type: Boolean, default: true }
}, { timestamps: true });

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
    displayName: String
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
    player1: {
      startggEntrantId: String,
      name: String
    },
    player2: {
      startggEntrantId: String,
      name: String
    },
    winnerId: Number
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
  // optional source metadata for import tracing
  source: {
    type: { type: String },
    externalId: String,
    tournamentId: String,
    url: String,
    importedAt: Date
  }
}, { timestamps: true });

const matchSchema = new mongoose.Schema({
  challongeId: { type: Number, unique: true, sparse: true },
  tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament' },
  tournamentChallongeId: Number,
  state: String,
  groupId: Number,
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

raceSchema.pre('save', function(next) {
  if (Array.isArray(this.entrants)) {
    for (const ent of this.entrants) {
      if ((ent.finishTime || ent.finishTime === 0) && !ent.finishTimeMs) {
        const ms = _parseTimeToMs(ent.finishTime);
        if (ms != null) ent.finishTimeMs = ms;
      }
    }
  }
  next();
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
playerSchema.pre('save', function(next) {
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
  next();
});

// Indexes for better query performance
// Indexes
tournamentSchema.index({ gameId: 1, startDate: -1 });
// consider also indexing new relation
tournamentSchema.index({ game: 1, startDate: -1 });
matchSchema.index({ tournamentId: 1 });
raceSchema.index({ tournamentId: 1 });
raceSchema.index({ category: 1, startedAt: -1 });
// Add composite index for live queries
raceSchema.index({ status: 1, startedAt: -1 });
playerSchema.index({ name: 1 });

module.exports = {
  Game: mongoose.model('Game', gameSchema),
  Tournament: mongoose.model('Tournament', tournamentSchema),
  Match: mongoose.model('Match', matchSchema),
  Race: mongoose.model('Race', raceSchema),
  Player: mongoose.model('Player', playerSchema)
};
