import assert from 'node:assert/strict';
import handler from '../api/proxy.js';

const originalFetch = globalThis.fetch;
const originalWorkerUrl = process.env.CLOUDFLARE_WORKER_URL;
const originalAppOrigin = process.env.APP_ORIGIN;
process.env.CLOUDFLARE_WORKER_URL = 'https://medicine-api.example.workers.dev';
process.env.APP_ORIGIN = 'https://medicine.example.com';
let forwarded;
globalThis.fetch = async (url, options) => {
  forwarded = {url: String(url), options};
  return new Response(JSON.stringify({ok: true}), {status: 201, headers: {'Content-Type': 'application/json'}});
};

function fakeRequest(method, url, headers = {}, body = '') {
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body);
    },
  };
}

function fakeResponse() {
  return {
    headers: {},
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
  };
}

try {
  const response = fakeResponse();
  await handler(fakeRequest('POST', '/api/bills?view=1', {
    origin: 'https://medicine.example.com',
    authorization: 'Bearer header.payload.signature',
    'content-type': 'application/json',
    'idempotency-key': 'unique-submission-key',
  }, '{"patient_name":"Test"}'), response);
  assert.equal(response.statusCode, 201);
  assert.equal(forwarded.url, 'https://medicine-api.example.workers.dev/api/bills?view=1');
  assert.equal(forwarded.options.headers.Authorization, 'Bearer header.payload.signature');
  assert.equal(forwarded.options.headers.Origin, 'https://medicine.example.com');
  assert.equal(forwarded.options.headers['Idempotency-Key'], 'unique-submission-key');
  assert.equal(forwarded.options.body.toString(), '{"patient_name":"Test"}');
  console.log('PASS Vercel proxy forwards the Google identity token, origin and write safely');

  const rewritten=fakeResponse();
  await handler(fakeRequest('DELETE','/api/proxy?_medicine_path=medicines%2Fexample-id&view=1',{
    origin:'https://medicine.example.com',authorization:'Bearer header.payload.signature','content-type':'application/json','idempotency-key':'delete-stock-intent',
  },'{}'),rewritten);
  assert.equal(rewritten.statusCode,201);
  assert.equal(forwarded.url,'https://medicine-api.example.workers.dev/api/medicines/example-id?view=1');
  assert.equal(forwarded.options.method,'DELETE');
  console.log('PASS explicit wildcard rewrite preserves nested API paths, query parameters and DELETE requests');
  const invalidRoute=fakeResponse();
  await handler(fakeRequest('GET','/api/proxy?_medicine_path=..%2Fother',{authorization:'Bearer header.payload.signature'}),invalidRoute);
  assert.equal(invalidRoute.statusCode,404);
  const rejected = fakeResponse();
  await handler(fakeRequest('POST', '/api/bills', {
    origin: 'https://attacker.example',
    authorization: 'Bearer header.payload.signature',
  }, '{}'), rejected);
  assert.equal(rejected.statusCode, 403);
  console.log('PASS Vercel proxy rejects cross-origin writes');

  const anonymous = fakeResponse();
  await handler(fakeRequest('GET', '/api/me'), anonymous);
  assert.equal(anonymous.statusCode, 401);
  console.log('PASS Vercel proxy rejects requests without Google identity');

  const oversized = fakeResponse();
  await handler(fakeRequest('POST', '/api/bills', {
    origin: 'https://medicine.example.com',
    authorization: 'Bearer header.payload.signature',
  }, 'x'.repeat(32768)), oversized);
  assert.equal(oversized.statusCode, 413);
  console.log('PASS Vercel proxy enforces the request-size limit');
} finally {
  globalThis.fetch = originalFetch;
  if (originalWorkerUrl === undefined) delete process.env.CLOUDFLARE_WORKER_URL;
  else process.env.CLOUDFLARE_WORKER_URL = originalWorkerUrl;
  if (originalAppOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = originalAppOrigin;
}
