// The site shown as a game's "Official site": the one chosen
// (resources.officialSite), else its only known site. A Discord thread is a
// support channel, not a site: it is never the official one.
// public/js/games.js and game-detail.js apply the same rule in the browser.

const DISCORD_URL = /^https?:\/\/([a-z0-9-]+\.)?(discord\.(com|gg)|discordapp\.com)\//i;

function isDiscordUrl(url) {
  return DISCORD_URL.test(String(url || ''));
}

function pickOfficialSite(resources = {}) {
  const chosen = resources.officialSite;
  if (chosen?.url) return isDiscordUrl(chosen.url) ? null : chosen;
  const sites = resources.sites || [];
  if (sites.length === 1 && sites[0].url && !isDiscordUrl(sites[0].url)) return sites[0];
  return null;
}

module.exports = { isDiscordUrl, pickOfficialSite };
