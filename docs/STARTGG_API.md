# Start.gg API Integration

## Setup

### 1. Get API Token

1. Go to https://start.gg/admin/profile/developer
2. Click "Create new token"
3. Enter a description (e.g., "Randomizer Tournament Import")
4. Copy the token immediately (you won't see it again!)

### 2. Set Environment Variable

Add to your `.env` file:
```bash
STARTGG_API_TOKEN=your_token_here
```

Or export temporarily:
```bash
export STARTGG_API_TOKEN=your_token_here
```

## Testing

Test the API with the OOT tournament:

```bash
node scripts/test-startgg.js https://www.start.gg/tournament/ocarina-of-time-randomizer-standard-tournament-season-9/events
```

This will:
- Fetch tournament data
- Display events, standings, and matches
- Show the data structure for mapping

## API Structure

### Key Differences from Challonge

| Feature | Challonge | Start.gg |
|---------|-----------|----------|
| API Type | REST | GraphQL |
| Auth | API Key in params | Bearer token in header |
| Tournament | Single bracket | Multiple events per tournament |
| Participants | Participants | Entrants (can be teams) |
| Matches | Matches | Sets |
| Time format | ISO strings | Unix timestamps (seconds) |

### GraphQL Query Example

```graphql
query TournamentQuery($slug: String!) {
  tournament(slug: $slug) {
    id
    name
    events {
      id
      name
      standings {
        nodes {
          placement
          entrant {
            name
          }
        }
      }
    }
  }
}
```

## Next Steps

1. **Test the API** with `test-startgg.js`
2. **Review output** to understand data structure
3. **Create import script** (similar to `import-challonge.js`)
4. **Map data** to your database schema:
   - Tournament → tournaments collection
   - Event → tournament event (multiple per tournament)
   - Entrant → player (may need to resolve team → individual players)
   - Standing → final ranking
   - Set → match (optional, if you want match history)

## Files Created

- `services/startgg.js` - Start.gg API client
- `scripts/test-startgg.js` - Test script to explore API
- `scripts/import-startgg.js` - (TODO) Import script for tournaments

## Resources

- [Start.gg Developer Portal](https://developer.start.gg/)
- [API Explorer](https://developer.start.gg/explorer)
- [GraphQL Schema](https://developer.start.gg/reference/query.doc.html)
