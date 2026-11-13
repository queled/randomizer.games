const test = require('node:test');
const assert = require('node:assert/strict');
const {
  checkProxyUrl,
  validateProxyUrl,
  isSafeImageContentType,
  setRelayedImageHeaders,
  validatePagination,
  validateObjectId,
  mongoSanitize,
  errorHandler
} = require('../middleware/security');

// Minimal Express response: records the status, the JSON body and the headers
const fakeRes = () => {
  const res = { statusCode: 200, body: undefined, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  return res;
};

// Runs a middleware and tells whether it let the request through
const run = (middleware, req) => {
  const res = fakeRes();
  let passed = false;
  middleware(req, res, () => { passed = true; });
  return { res, passed };
};

test('image proxy: an allowed host and its subdomains go through', () => {
  assert.deepEqual(checkProxyUrl('https://racetime.gg/media/a.png'), { ok: true, url: 'https://racetime.gg/media/a.png' });
  assert.equal(checkProxyUrl('https://media.racetime.gg/a.png').ok, true);
  assert.equal(checkProxyUrl('https://RACETIME.gg/a.png').ok, true);
  assert.equal(checkProxyUrl('http://i.imgur.com/a.png').ok, true);
});

test('image proxy: a host that only looks like an allowed one is refused', () => {
  for (const url of [
    'https://example.com/a.png',
    'https://notracetime.gg/a.png',
    'https://racetime.gg.example.com/a.png',
    'https://example.com/racetime.gg/a.png',
    'https://example.com/?u=https://racetime.gg/a.png'
  ]) {
    const result = checkProxyUrl(url);
    assert.equal(result.ok, false, url);
    assert.equal(result.status, 403, url);
  }
});

test('image proxy: no credentials and no custom port, even on an allowed host', () => {
  for (const url of [
    'https://racetime.gg@example.com/a.png',
    'https://user:pass@racetime.gg/a.png',
    'https://racetime.gg:8080/a.png'
  ]) {
    const result = checkProxyUrl(url);
    assert.equal(result.ok, false, url);
    assert.equal(result.status, 403, url);
  }
});

test('image proxy: internal addresses are never fetched', () => {
  for (const url of [
    'http://127.0.0.1/a.png',
    'http://localhost/a.png',
    'http://10.0.0.5/a.png',
    'http://192.168.1.1/a.png',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/a.png'
  ]) {
    assert.equal(checkProxyUrl(url).ok, false, url);
  }
});

test('image proxy: only http and https URLs of a sane length', () => {
  for (const url of [
    'ftp://racetime.gg/a.png',
    'file:///etc/passwd',
    'javascript:alert(1)',
    '//racetime.gg/a.png',
    'racetime.gg/a.png',
    'not a url',
    '',
    null,
    undefined,
    ['https://racetime.gg/a.png'],
    `https://racetime.gg/${'a'.repeat(2048)}`
  ]) {
    const result = checkProxyUrl(url);
    assert.equal(result.ok, false, String(url).slice(0, 40));
    assert.equal(result.status, 400, String(url).slice(0, 40));
  }
});

test('image proxy middleware: answers 400 without a url, 403 for a foreign host, passes an allowed one', () => {
  const missing = run(validateProxyUrl, { query: {} });
  assert.equal(missing.passed, false);
  assert.equal(missing.res.statusCode, 400);

  const foreign = run(validateProxyUrl, { query: { url: 'https://example.com/a.png' } });
  assert.equal(foreign.passed, false);
  assert.equal(foreign.res.statusCode, 403);

  assert.equal(run(validateProxyUrl, { query: { url: 'https://racetime.gg/a.png' } }).passed, true);
});

test('relayed images: bitmap types only, SVG and pages refused', () => {
  for (const type of ['image/png', 'image/jpeg', 'IMAGE/WEBP', 'image/gif; charset=binary', ' image/avif ']) {
    assert.equal(isSafeImageContentType(type), true, type);
  }
  for (const type of ['image/svg+xml', 'text/html', 'application/javascript', 'image/png+xml', '', null, undefined]) {
    assert.equal(isSafeImageContentType(type), false, String(type));
  }
});

test('relayed images: the browser may neither sniff the type nor run anything', () => {
  const res = fakeRes();
  setRelayedImageHeaders(res);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.match(res.headers['content-security-policy'], /default-src 'none'/);
  assert.match(res.headers['content-security-policy'], /\bsandbox\b/);
  assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
});

test('pagination: limit and page become numbers within their bounds', () => {
  const req = { query: { limit: '50', page: '3' } };
  assert.equal(run(validatePagination, req).passed, true);
  assert.deepEqual(req.query, { limit: 50, page: 3 });

  assert.equal(run(validatePagination, { query: {} }).passed, true);
  assert.equal(run(validatePagination, { query: { limit: '100', page: '10000' } }).passed, true);
});

test('pagination: out of bounds or not a number answers 400', () => {
  for (const query of [
    { limit: '0' }, { limit: '101' }, { limit: '-5' }, { limit: 'abc' },
    { page: '0' }, { page: '10001' }, { page: 'abc' }
  ]) {
    const { res, passed } = run(validatePagination, { query });
    assert.equal(passed, false, JSON.stringify(query));
    assert.equal(res.statusCode, 400, JSON.stringify(query));
  }
});

test('object id: 24 hexadecimal characters, nothing else', () => {
  const check = validateObjectId('id');
  assert.equal(run(check, { params: { id: '0123456789abcdefABCDEF01' } }).passed, true);
  assert.equal(run(check, { params: {} }).passed, true);

  for (const id of ['123', '0123456789abcdefABCDEF0', '0123456789abcdefABCDEF012', 'zzzzzzzzzzzzzzzzzzzzzzzz', '../../etc/passwd']) {
    const { res, passed } = run(check, { params: { id } });
    assert.equal(passed, false, id);
    assert.equal(res.statusCode, 400, id);
  }
});

test('mongo operators and dotted paths are dropped from the query and the body, at any depth', () => {
  const req = {
    query: { name: 'abc', $where: '1', 'a.b': 'x', filter: { $ne: null, kept: 'yes' } },
    body: { items: [{ $gt: 1, label: 'ok' }], nested: { deep: { '$set': {}, value: 2 } } }
  };
  assert.equal(run(mongoSanitize, req).passed, true);
  assert.deepEqual(req.query, { name: 'abc', filter: { kept: 'yes' } });
  assert.deepEqual(req.body, { items: [{ label: 'ok' }], nested: { deep: { value: 2 } } });

  // The sanitized query stays writable for the middleware that follow
  req.query.limit = 5;
  assert.equal(req.query.limit, 5);
});

test('mongo sanitizing accepts a request without a body', () => {
  assert.equal(run(mongoSanitize, { query: {} }).passed, true);
});

test('errors: no message nor stack outside development, and a sane status', (t) => {
  t.mock.method(console, 'error', () => {});
  const previous = process.env.NODE_ENV;
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });
  const handle = (err) => {
    const res = fakeRes();
    errorHandler(err, { url: '/x', method: 'GET', ip: '::1' }, res, () => {});
    return res;
  };
  const failure = Object.assign(new Error('secret detail'), { status: 404 });

  for (const env of [undefined, 'production']) {
    if (env === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = env;
    const res = handle(failure);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: { message: 'An error occurred', status: 404 } });
  }

  process.env.NODE_ENV = 'development';
  const detailed = handle(failure);
  assert.equal(detailed.body.error.message, 'secret detail');
  assert.equal(typeof detailed.body.error.stack, 'string');

  process.env.NODE_ENV = 'production';
  assert.equal(handle(new Error('boom')).statusCode, 500);
  assert.equal(handle(Object.assign(new Error('boom'), { status: 200 })).statusCode, 500);
  assert.equal(handle(Object.assign(new Error('boom'), { status: 'abc' })).statusCode, 500);
});
