const test = require('node:test');
const assert = require('node:assert/strict');
const { pickOfficialSite, isDiscordUrl } = require('../helpers/official-site');

test('the chosen site comes first, else the only known one', () => {
  const chosen = { url: 'https://example.org/' };
  assert.equal(pickOfficialSite({ officialSite: chosen, sites: [{ url: 'https://other.example/' }] }), chosen);
  assert.equal(pickOfficialSite({ sites: [{ url: 'https://example.org/' }] }).url, 'https://example.org/');
  assert.equal(pickOfficialSite({ sites: [{ url: 'https://a.example/' }, { url: 'https://b.example/' }] }), null);
  assert.equal(pickOfficialSite({}), null);
});

test('a Discord link is never the official site', () => {
  assert.ok(isDiscordUrl('https://discord.com/channels/1/2'));
  assert.ok(isDiscordUrl('https://discord.gg/invite'));
  assert.ok(isDiscordUrl('https://cdn.discordapp.com/attachments/1/2/setup.exe'));
  assert.ok(!isDiscordUrl('https://github.com/example/discord-bot'));
  assert.equal(pickOfficialSite({ officialSite: { url: 'https://discord.com/channels/1/2' } }), null);
  assert.equal(pickOfficialSite({ sites: [{ url: 'https://discord.gg/invite' }] }), null);
});
