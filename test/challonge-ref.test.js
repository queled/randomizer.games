const test = require('node:test');
const assert = require('node:assert');
const { parseChallongeRef } = require('../scripts/discover-tournaments');

test('a bracket URL gives its API id, with the community subdomain', () => {
  assert.deepStrictEqual(parseChallongeRef('https://challonge.com/examplecup'), {
    apiId: 'examplecup', url: 'https://challonge.com/examplecup'
  });
  assert.deepStrictEqual(parseChallongeRef('https://somecommunity.challonge.com/examplecup'), {
    apiId: 'somecommunity-examplecup', url: 'https://somecommunity.challonge.com/examplecup'
  });
});

test('the language prefix of a bracket URL is left out, whatever its spelling', () => {
  for (const prefix of ['de', 'pt-BR', 'pt_BR']) {
    assert.deepStrictEqual(parseChallongeRef(`https://somecommunity.challonge.com/${prefix}/examplecup`), {
      apiId: 'somecommunity-examplecup', url: 'https://somecommunity.challonge.com/examplecup'
    });
  }
});
