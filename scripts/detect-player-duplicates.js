/**
 * Utility script to detect potential player duplicates
 * 
 * Analyzes players from tournaments and races to find likely duplicates based on:
 * 1. Name similarity (Levenshtein distance)
 * 2. Shared tournament/race participation
 * 3. Name patterns (e.g., invitation pending suffix)
 * 
 * Usage: node scripts/detect-player-duplicates.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { Tournament, Race, Player } = require('../models');
const { getCanonicalName, PLAYER_ALIASES } = require('../config/player-aliases');

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

// Levenshtein distance for string similarity
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({length: m+1}, () => new Array(n+1));
  for (let i=0;i<=m;i++) dp[i][0]=i;
  for (let j=0;j<=n;j++) dp[0][j]=j;
  for (let i=1;i<=m;i++){
    for (let j=1;j<=n;j++){
      const cost = a[i-1] === b[j-1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
    }
  }
  return dp[m][n];
}

// Normalize name for comparison
function normalizeName(name) {
  if (!name) return '';
  return name.toString()
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}

// Check if name has invitation pending suffix
function hasInvitationPending(name) {
  return /\(invitation pending\)/i.test(name);
}

// Strip invitation pending suffix
function stripInvitationPending(name) {
  return name.replace(/\s*\(invitation pending\)\s*/gi, '').trim();
}

async function detectDuplicates() {
  console.log('🔍 Detecting potential player duplicates...\n');

  try {
    // Get all tournaments
    const tournaments = await Tournament.find({});
    
    // Get all races
    const races = await Race.find({});
    
    // Get all Player documents
    const playerDocs = await Player.find({});
    
    // Build player profiles with participation data
    const playerProfiles = new Map();
    
    // Collect from tournaments
    tournaments.forEach(t => {
      if (!t.participants) return;
      t.participants.forEach(p => {
        const name = p.displayName || p.name;
        if (!name) return;
        
        const canonical = getCanonicalName(name);
        const normalized = normalizeName(canonical);
        
        if (!playerProfiles.has(normalized)) {
          playerProfiles.set(normalized, {
            names: new Set(),
            tournaments: new Set(),
            races: new Set(),
            hasRacetimeProfile: false
          });
        }
        
        const profile = playerProfiles.get(normalized);
        profile.names.add(name);
        profile.tournaments.add(t._id.toString());
      });
    });
    
    // Collect from races
    races.forEach(r => {
      if (!r.entrants) return;
      r.entrants.forEach(e => {
        const name = e.userName || e.userId;
        if (!name) return;
        
        const canonical = getCanonicalName(name);
        const normalized = normalizeName(canonical);
        
        if (!playerProfiles.has(normalized)) {
          playerProfiles.set(normalized, {
            names: new Set(),
            tournaments: new Set(),
            races: new Set(),
            hasRacetimeProfile: false
          });
        }
        
        const profile = playerProfiles.get(normalized);
        profile.names.add(name);
        profile.races.add(r._id.toString());
      });
    });
    
    // Mark players with Racetime profiles
    playerDocs.forEach(p => {
      const normalized = normalizeName(p.name);
      if (playerProfiles.has(normalized)) {
        playerProfiles.get(normalized).hasRacetimeProfile = true;
      }
    });
    
    // Find potential duplicates
    const allPlayers = Array.from(playerProfiles.entries()).map(([norm, data]) => ({
      normalized: norm,
      names: Array.from(data.names),
      primaryName: Array.from(data.names)[0],
      tournaments: data.tournaments,
      races: data.races,
      hasRacetimeProfile: data.hasRacetimeProfile
    }));
    
    const candidates = [];
    
    for (let i = 0; i < allPlayers.length; i++) {
      for (let j = i + 1; j < allPlayers.length; j++) {
        const p1 = allPlayers[i];
        const p2 = allPlayers[j];
        
        // Skip if already in alias config
        const isKnown = p1.names.some(n1 => 
          p2.names.some(n2 => getCanonicalName(n1) === getCanonicalName(n2))
        );
        if (isKnown) continue;
        
        // Calculate similarity
        const dist = levenshtein(p1.normalized, p2.normalized);
        const maxLen = Math.max(p1.normalized.length, p2.normalized.length);
        const similarity = 1 - (dist / maxLen);
        
        // Check for shared participation
        const sharedTournaments = new Set([...p1.tournaments].filter(t => p2.tournaments.has(t)));
        const sharedRaces = new Set([...p1.races].filter(r => p2.races.has(r)));
        
        // Check invitation pending pattern
        const p1HasPending = p1.names.some(hasInvitationPending);
        const p2HasPending = p2.names.some(hasInvitationPending);
        const invitationPendingMatch = (p1HasPending || p2HasPending) && 
          p1.names.some(n1 => p2.names.some(n2 => 
            normalizeName(stripInvitationPending(n1)) === normalizeName(stripInvitationPending(n2))
          ));
        
        // Score the match
        let score = 0;
        let reasons = [];
        
        if (similarity > 0.8) {
          score += 50;
          reasons.push(`High name similarity (${(similarity * 100).toFixed(0)}%)`);
        } else if (similarity > 0.6) {
          score += 25;
          reasons.push(`Moderate name similarity (${(similarity * 100).toFixed(0)}%)`);
        }
        
        if (sharedTournaments.size > 0) {
          score += sharedTournaments.size * 20;
          reasons.push(`${sharedTournaments.size} shared tournament(s)`);
        }
        
        if (sharedRaces.size > 0) {
          score += sharedRaces.size * 10;
          reasons.push(`${sharedRaces.size} shared race(s)`);
        }
        
        if (invitationPendingMatch) {
          score += 100;
          reasons.push('Invitation pending suffix match');
        }
        
        // Only report if score is significant
        if (score >= 50 || invitationPendingMatch) {
          candidates.push({
            player1: p1.primaryName,
            player2: p2.primaryName,
            score,
            reasons,
            p1HasRacetime: p1.hasRacetimeProfile,
            p2HasRacetime: p2.hasRacetimeProfile
          });
        }
      }
    }
    
    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);
    
    // Report findings
    console.log(`Found ${candidates.length} potential duplicate pairs:\n`);
    
    candidates.forEach((c, idx) => {
      const canonical = c.p1HasRacetime ? c.player1 : (c.p2HasRacetime ? c.player2 : c.player1);
      const alias = canonical === c.player1 ? c.player2 : c.player1;
      
      console.log(`${idx + 1}. [Score: ${c.score}]`);
      console.log(`   "${alias}" → "${canonical}"`);
      console.log(`   Racetime: ${c.p1HasRacetime ? c.player1 : c.p2HasRacetime ? c.player2 : 'neither'}`);
      console.log(`   Reasons: ${c.reasons.join(', ')}`);
      console.log('');
    });
    
    console.log('\n📝 Suggested additions to config/player-aliases.js:\n');
    console.log('const PLAYER_ALIASES = {');
    console.log('  // ... existing aliases ...\n');
    candidates.slice(0, 20).forEach(c => {
      const canonical = c.p1HasRacetime ? c.player1 : (c.p2HasRacetime ? c.player2 : c.player1);
      const alias = canonical === c.player1 ? c.player2 : c.player1;
      console.log(`  '${alias}': '${canonical}',  // ${c.reasons[0]}`);
    });
    console.log('};');
    
  } catch (error) {
    console.error('Error detecting duplicates:', error);
  } finally {
    await mongoose.disconnect();
  }
}

detectDuplicates();
