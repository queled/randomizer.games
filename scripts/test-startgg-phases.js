#!/usr/bin/env node
/**
 * Test Start.gg API for phases and sets
 */
require('dotenv').config();
const axios = require('axios');

const STARTGG_API = 'https://api.start.gg/gql/alpha';

async function query(gql, variables = {}) {
  const response = await axios.post(
    STARTGG_API,
    { query: gql, variables },
    {
      headers: {
        'Authorization': `Bearer ${process.env.STARTGG_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
  if (response.data.errors) {
    console.error('GraphQL errors:', response.data.errors);
    throw new Error(response.data.errors[0].message);
  }
  return response.data.data;
}

async function main() {
  const eventSlug = 'tournament/ocarina-of-time-randomizer-standard-tournament-season-9/event/main-tournament';
  
  console.log('🔍 Fetching event with phases and sets...\n');
  
  const data = await query(`
    query EventWithPhases($slug: String!) {
      event(slug: $slug) {
        id
        name
        state
        type
        phases {
          id
          name
          numSeeds
          bracketType
          phaseOrder
          state
          groupCount
        }
        sets(page: 1, perPage: 50, sortType: STANDARD) {
          pageInfo { 
            total 
            totalPages
          }
          nodes {
            id
            round
            displayScore
            completedAt
            state
            phaseGroup {
              id
              displayIdentifier
              phase {
                id
                name
              }
            }
            slots {
              entrant { 
                id
                name 
              }
            }
          }
        }
      }
    }
  `, { slug: eventSlug });

  const event = data.event;
  
  console.log('=== EVENT ===');
  console.log('Name:', event.name);
  console.log('State:', event.state);
  console.log('Type:', event.type);
  
  console.log('\n=== PHASES ===');
  if (event.phases?.length) {
    event.phases.forEach(p => {
      console.log(`  ${p.phaseOrder}. ${p.name}`);
      console.log(`     Type: ${p.bracketType}, Seeds: ${p.numSeeds}, Groups: ${p.groupCount}, State: ${p.state}`);
    });
  } else {
    console.log('  No phases found');
  }
  
  console.log('\n=== SETS (matches) ===');
  console.log('Total sets:', event.sets?.pageInfo?.total || 0);
  console.log('Total pages:', event.sets?.pageInfo?.totalPages || 0);
  
  if (event.sets?.nodes?.length) {
    console.log('\nFirst 10 sets:');
    event.sets.nodes.slice(0, 10).forEach(s => {
      const p1 = s.slots?.[0]?.entrant?.name || 'TBD';
      const p2 = s.slots?.[1]?.entrant?.name || 'TBD';
      const phase = s.phaseGroup?.phase?.name || 'Unknown';
      const status = s.completedAt ? '✅' : (s.state === 1 ? '🔴' : '⏳');
      console.log(`  ${status} R${s.round}: ${p1} vs ${p2} - ${s.displayScore || 'Not played'} [${phase}]`);
    });
  } else {
    console.log('  No sets found');
  }
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
