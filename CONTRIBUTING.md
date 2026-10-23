# Contributing to Randomizer.Games

Thanks for your interest in the project! Contributions of every size are welcome, and you don't need to write code to help.

## Ways to help

- **Fix the data**: a missing tournament, a player listed under two names, a race attached to the wrong match, a wrong game link. [Open an issue](https://github.com/queled/randomizer.games/issues) with the page URL and what should change.
- **Report a bug**: say what you did, what you expected and what happened instead, with your browser (or Node.js version and OS for local setups) and a screenshot if useful.
- **Improve translations**: the site exists in English, French, Spanish, German, Italian and Portuguese; the strings live in `public/js/i18n/`.
- **Suggest a feature**: open an issue first so we can agree on the approach before you spend time on it.
- **Write code**: pick an open issue, or open one describing what you want to change.

Security problems must **not** be reported in a public issue: follow [SECURITY.md](SECURITY.md).

## Setting up

Follow [Running it locally](README.md#running-it-locally) in the README. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains where the data comes from and what each script does.

## Making a change

1. Fork the repository and create a branch from `main`, e.g. `fix/player-aliases` or `feat/race-filters`.
2. Keep each pull request on one topic; small PRs are reviewed faster.
3. Follow the style of the surrounding code. A few project rules:
   - no inline event handlers (`onclick=…`) in HTML: use `data-*` attributes with `public/js/ui-events.js`;
   - every user-facing text goes through the translation files, in all languages (English text is fine as a placeholder for the ones you don't speak);
   - never commit `.env` or secrets; add new variables to `.env.example` with a comment;
   - scripts that write to the database should offer a `--dry-run` mode.
4. Check your change:
   - run `npm test` (the helpers' tests in `test/`; add one when you change their logic);
   - run the site (`npm run dev`) and go through the pages you touched, in a narrow (mobile) window as well;
   - run `npm run check-security`;
   - for a script, run it with `--dry-run` first.
5. Write commit messages in the [Conventional Commits](https://www.conventionalcommits.org) format: `feat: …`, `fix: …`, `docs: …`, `refactor: …`, `chore: …`.
6. Open the pull request. Explain **what** changes and **why**, link the related issue (`Closes #12`), and add screenshots for visual changes.

A maintainer will review it; expect questions or change requests. A feature that doesn't fit the project may be declined, which is why discussing it in an issue first is worth it.

## Code of conduct

Be respectful and constructive. Harassment, insults or discrimination of any kind are not tolerated in issues, pull requests or any project space.

## License

By contributing, you agree that your contributions are released under the project's [MIT License](LICENSE).
