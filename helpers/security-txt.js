// security.txt (RFC 9116): where to report a vulnerability, same channels as
// SECURITY.md. The file must say when it expires; the date is set a year after
// each request so that it never goes stale.
const SITE = 'https://randomizer.games';
const REPO = 'https://github.com/queled/randomizer.games';
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const securityTxt = (now = new Date()) => {
  const expires = new Date(now.getTime() + ONE_YEAR_MS);
  expires.setUTCHours(0, 0, 0, 0);
  return [
    `Contact: ${REPO}/security/advisories/new`,
    'Contact: mailto:contact@randomizer.games',
    `Expires: ${expires.toISOString()}`,
    'Preferred-Languages: en, fr',
    `Policy: ${REPO}/security/policy`,
    `Canonical: ${SITE}/.well-known/security.txt`,
    ''
  ].join('\n');
};

module.exports = { securityTxt };
