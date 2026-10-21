# 🎲 Randomizer.Games

**[randomizer.games](https://randomizer.games)** gathers the history of the randomizer community in one place: games, races, tournaments and players.

A *randomizer* is a mod that shuffles where items, abilities or other game elements are found, so a game you know by heart turns into a new puzzle every time. Races and tournaments on these games are scattered across racetime.gg, start.gg, Challonge and many Discord servers; this site collects them so they are easy to browse and stay archived.

## What you can do on the site

- 🎮 **Browse randomizer games**: the full catalog of randomizers, with links to each randomizer, its trackers, guides and community
- 🥇 **Look up races**: results, times and rankings, from racetime.gg and the older SpeedRunsLive history
- 🏆 **Follow tournaments**: brackets, matches and qualifiers, with the races played for each match
- 👤 **Explore player profiles**: race and tournament history across every game, and side-by-side comparison
- 📺 **Watch live streams** of randomizer games on Twitch
- 🙈 **Anti-spoiler mode**: hide results to watch a VOD without knowing who won
- 🌍 Available in English, French, Spanish, German, Italian and Portuguese

## Where the data comes from

Everything shown is public data, refreshed automatically:

| Source | Used for |
|--------|----------|
| [racetime.gg](https://racetime.gg) | Races, every few minutes |
| [SpeedRunsLive](https://www.speedrunslive.com) | Races from before racetime.gg |
| [start.gg](https://start.gg) and [Challonge](https://challonge.com) | Tournaments, brackets and matches |
| [rando-list](https://github.com/video-game-randomizers/rando-list) | The list of games and randomizers |
| [Archipelago](https://archipelago.gg/games) and [Multiworld](https://multiworld.gg/games) | Games playable in an Archipelago multiworld |
| [Community APWorlds list](https://docs.google.com/spreadsheets/d/1iuzDTOAvdoNe8Ne8i461qGNucg5OuEoF-Ikqs8aUQZw/edit) | Worlds distributed outside Archipelago: downloads, stability, trackers, setup guides |
| [speedrun.com](https://www.speedrun.com) | Game details (platforms, release year) |
| [Twitch](https://twitch.tv) | Live streams |

Something missing or wrong, like a tournament, a player under two names, or a race linked to the wrong match? [Open an issue](https://github.com/queled/randomizer.games/issues).

## Running it locally

You need **Node.js 20+** and a **MongoDB** database (local or [Atlas](https://www.mongodb.com/atlas)).

```bash
git clone https://github.com/queled/randomizer.games.git
cd randomizer.games
npm install
cp .env.example .env    # set MONGODB_URI; NODE_ENV=development is enough to start
npm run dev
```

The site runs on <http://localhost:3000> and the admin panel on `/admin`.

An empty database gives an empty site. To get some content, seed a few games, then pull their recent races from racetime.gg:

```bash
npm run import-games -- data/games-template.csv --full
npm run sync
```

Go further:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): data sources, automated syncs, data model and every script
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): putting the site in production

Built with Node.js, Express and MongoDB; the front end is plain HTML, CSS and JavaScript.

## Contributing

Bug reports, data fixes, translations and code are all welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). To report a security issue, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## License

The code is released under the [MIT License](LICENSE).

Game names, logos and box art in `public/assets/` belong to their respective owners and are not covered by the MIT License. Race and tournament data come from racetime.gg, SpeedRunsLive, start.gg, Challonge and speedrun.com.
