import assert from 'node:assert/strict';

const worker = (await import('../_worker.mjs')).default;

const originalFetch = globalThis.fetch;
const seen = [];

globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input.url;
  seen.push(url);
  return new Response('not a playlist', { status: 404 });
};

try {
  const body = {
    url: 'http://line.trxdnscloud.ru/',
    username: '4e83212baf',
    password: 'e475d65f6e',
    mac: '00:1A:79:C0:A1:36'
  };
  const request = new Request('https://media26.test/api/playlist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  await worker.fetch(request, { ASSETS: { fetch: () => new Response('asset') } });

  const macAsUser = seen.filter((url) => {
    const u = new URL(url);
    return u.searchParams.get('username') === body.mac
      && u.searchParams.get('password') === body.mac;
  });

  assert.deepEqual(
    macAsUser,
    [],
    'credential playlist login must not try MAC-keyed username/password playlist URLs'
  );
} finally {
  globalThis.fetch = originalFetch;
}
