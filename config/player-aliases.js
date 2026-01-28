/**
 * Player aliases configuration
 * Maps duplicate player names to their canonical Racetime name
 * 
 * Structure: 'challonge-name' or 'variant-name' -> 'canonical-racetime-name'
 * 
 * When consolidating:
 * - The canonical name (right side) takes priority for profile data (Racetime URL, stats)
 * - Tournament participations from all aliases are merged under the canonical name
 * - Race data is preserved with the original userName but linked to canonical profile
 */

const PLAYER_ALIASES = {
  // Format: 'alternate-name': 'canonical-racetime-name'
  
  // Confirmed from race data analysis
  'TheAranaut': 'Aranaut',                  // Aranaut is the Racetime name (appears in races)
  'Flouflouche': 'Flouche',                 // Flouche is the Racetime name (appears in races)
  'cola_osu': 'Cola',                       // Cola is the Racetime name (appears in races)
  'Pyra2366': 'Pyra',                       // Pyra is the Racetime name (appears in races)
  'Volc-41': 'Volc',                        // Volc is the Racetime name (appears in races)
  
  // Manually verified from racetime.gg profiles
  'Challensois': 'Challensois_',            // racetime.gg/user/R8QGZrB2k03Ngk4V/challensois
  'Jaybone25 (invitation pending)': 'Jaybone25',  // racetime.gg/user/OR6ym83mXqBPd1Xr/jaybone25
  'Meanmido (invitation pending)': 'meanmido',    // racetime.gg/user/N5zbdeWe6BYPK8Ok/meanmido
  'r0bd0g (invitation pending)': 'r0bd0g',        // racetime.gg/user/vrZyM4orJ1oqDJX0/r0bd0g
  'Riley2w69t': 'Riley',                    // racetime.gg/user/NJrM6PoYZ5WRdm5v/riley
  'TrenteR_TR': 'TrenteR',                  // racetime.gg/user/TrenteR
  
  // Uncertain cases (commented out until confirmed)
  // 'Yoyocarina': 'Yoyocanari',  // Need confirmation
};

/**
 * Normalize name for matching (case-insensitive, trim, remove accents)
 */
function normalizePlayerName(name) {
  if (!name && name !== 0) return '';
  return String(name)
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Get canonical name for a player, resolving through alias chain
 */
function getCanonicalName(name) {
  if (!name) return name;
  
  // Check exact match first
  if (PLAYER_ALIASES[name]) {
    return PLAYER_ALIASES[name];
  }
  
  // Check normalized match
  const normalized = normalizePlayerName(name);
  for (const [alias, canonical] of Object.entries(PLAYER_ALIASES)) {
    if (normalizePlayerName(alias) === normalized) {
      return canonical;
    }
  }
  
  // No alias found, return original
  return name;
}

/**
 * Check if two player names refer to the same person
 */
function isSamePlayer(name1, name2) {
  if (!name1 || !name2) return false;
  
  const canonical1 = getCanonicalName(name1);
  const canonical2 = getCanonicalName(name2);
  
  return normalizePlayerName(canonical1) === normalizePlayerName(canonical2);
}

/**
 * Get all known aliases for a canonical name
 */
function getAliases(canonicalName) {
  const aliases = [];
  const canonicalNorm = normalizePlayerName(canonicalName);
  
  for (const [alias, canonical] of Object.entries(PLAYER_ALIASES)) {
    if (normalizePlayerName(canonical) === canonicalNorm) {
      aliases.push(alias);
    }
  }
  
  return aliases;
}

module.exports = {
  PLAYER_ALIASES,
  normalizePlayerName,
  getCanonicalName,
  isSamePlayer,
  getAliases
};
