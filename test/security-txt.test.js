const test = require('node:test');
const assert = require('node:assert/strict');
const { securityTxt } = require('../helpers/security-txt');

test('security.txt: the required fields are there', () => {
  const text = securityTxt(new Date('2030-03-15T12:34:56Z'));
  assert.match(text, /^Contact: https:\/\/github\.com\/.+\/security\/advisories\/new$/m);
  assert.match(text, /^Contact: mailto:/m);
  assert.match(text, /^Canonical: https:\/\/randomizer\.games\/\.well-known\/security\.txt$/m);
  assert.ok(text.endsWith('\n'));
});

test('security.txt: it expires about a year later, at midnight UTC', () => {
  const text = securityTxt(new Date('2030-03-15T12:34:56Z'));
  assert.match(text, /^Expires: 2031-03-15T00:00:00\.000Z$/m);
});
