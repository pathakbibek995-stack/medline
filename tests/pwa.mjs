import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Script, createContext, runInContext} from 'node:vm';
import {pwaAssets} from '../scripts/pwa-assets.mjs';

const assets = await pwaAssets();
const manifest = JSON.parse(Buffer.from(assets['/manifest.webmanifest'].body, 'base64'));
assert.equal(manifest.display, 'standalone');
assert.equal(manifest.start_url, '/');
assert.equal(manifest.scope, '/');
for (const icon of manifest.icons) {
  const png = Buffer.from(assets[icon.src].body, 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const [width, height] = icon.sizes.split('x').map(Number);
  assert.equal(png.readUInt32BE(16), width);
  assert.equal(png.readUInt32BE(20), height);
}

const worker = (await import('../dist/server/index.js')).default;
for (const [path, asset] of Object.entries(assets)) {
  const response = await worker.fetch(new Request('https://app.test' + path), {});
  assert.equal(response.status, 200, path);
  assert.equal(response.headers.get('Content-Type'), asset.type);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(asset.body, 'base64'));
  assert.equal((await worker.fetch(new Request('https://app.test' + path), {WORKER_PROXY_ONLY: 'true'})).status, 404);
}
console.log('PASS PWA assets and valid icon dimensions are served by the app, not the API-only Worker');

const handlers = {};
let networkFails = false, networkRequest;
const swContext = createContext({
  URL, Response,
  self: {
    location: {origin: 'https://app.test'},
    addEventListener: (name, handler) => { handlers[name] = handler; },
    skipWaiting: async () => {}, clients: {claim: async () => {}},
  },
  fetch: async (request, options) => {
    networkRequest = {request, options};
    if (networkFails) throw new TypeError('Network unavailable');
    return new Response('Live app');
  },
  // Any attempt to use offline storage is a failure.
  caches: new Proxy({}, {get() { throw Error('Offline caching is forbidden'); }}),
});
runInContext(Buffer.from(assets['/sw.js'].body, 'base64').toString(), swContext);
for (const name of ['install', 'activate']) {
  let pending;
  handlers[name]({waitUntil: value => { pending = value; }});
  await pending;
}
const navigation = {url: 'https://app.test/', method: 'GET', mode: 'navigate'};
let result;
handlers.fetch({request: navigation, respondWith: promise => { result = promise; }});
assert.equal(await (await result).text(), 'Live app');
assert.equal(networkRequest.options.cache, 'no-store');
networkFails = true;
handlers.fetch({request: navigation, respondWith: promise => { result = promise; }});
const unavailable = await result;
assert.equal(unavailable.status, 503);
const noConnection = await unavailable.text();
assert.match(noConnection, /No connection/);
assert.doesNotMatch(noConnection, /__NO_CONNECTION_HTML__/);
assert.equal(unavailable.headers.get('Cache-Control'), 'no-store');
for (const request of [
  {...navigation, url: 'https://app.test/api/me'},
  {...navigation, url: 'https://app.test/api/bills', method: 'POST'},
  {...navigation, url: 'https://app.test/api/medicines', mode: 'cors'},
  {...navigation, url: 'https://accounts.google.com/'},
]) {
  handlers.fetch({request, respondWith() { throw Error('Must not intercept API, writes or external requests'); }});
}
console.log('PASS service worker fetches live pages, shows No connection on failure and never caches or queues requests');

const html = await readFile('worker/app.html', 'utf8');
const appScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
new Script(appScript);
new Script(await readFile('worker/pwa/install.js', 'utf8'));
let focused, calls = 0;
const nodes = new Map();
function node(selector) {
  if (!nodes.has(selector)) nodes.set(selector, {
    hidden: true, open: false, isConnected: true, value: '',
    addEventListener() {}, setAttribute() {},
    focus() { focused = selector; }, close() { this.open = false; },
  });
  return nodes.get(selector);
}
const events = {};
const appContext = createContext({
  console, URL, Date, Intl, crypto: globalThis.crypto, setTimeout, clearTimeout,
  navigator: {onLine: false},
  location: {hash: ''},
  window: {addEventListener: (name, handler) => { events[name] = handler; }},
  document: {querySelector: node, querySelectorAll: () => [], addEventListener() {}, activeElement: node('previous-focus')},
  MutationObserver: class {observe() {}},
  fetch: async () => { calls++; throw Error('Network down'); },
});
runInContext(appScript, appContext);
assert.equal(node('#connection-screen').hidden, false);
assert.equal(node('.layout').inert, true);
assert.equal(focused, '#connection-screen');
await assert.rejects(runInContext("write('/bills',{},'same-key')", appContext), /No connection/);
assert.equal(calls, 0, 'Offline writes must not reach the network or a queue');
runInContext("billDraft.patient_name='Draft patient';user={role:'owner'};navigator.onLine=true", appContext);
events.online();
assert.equal(node('#connection-screen').hidden, true);
assert.equal(node('.layout').inert, false);
assert.equal(runInContext('billDraft.patient_name', appContext), 'Draft patient');
await assert.rejects(runInContext("api('/medicines')", appContext), /No connection/);
assert.equal(node('#connection-screen').hidden, false, 'A network failure also blocks the app');
assert.equal(calls, 1);
console.log('PASS connection screen blocks offline writes, catches network failures and preserves the in-tab bill draft');

const installSource = await readFile('worker/pwa/install.js', 'utf8');
function installHarness(ios = false, standalone = false) {
  const listeners = {}, buttons = new Map();
  let registered;
  const element = id => {
    if (!buttons.has(id)) buttons.set(id, {
      hidden: true, open: false, listeners: {},
      addEventListener(name, handler) { this.listeners[name] = handler; },
      showModal() { this.open = true; }, close() { this.open = false; },
    });
    return buttons.get(id);
  };
  runInContext(installSource, createContext({
    console,
    document: {querySelector: element},
    window: {
      isSecureContext: true,
      matchMedia: () => ({matches: standalone}),
      addEventListener: (name, handler) => { listeners[name] = handler; },
    },
    navigator: {
      userAgent: ios ? 'iPhone' : 'Chrome', platform: '', maxTouchPoints: 0,
      serviceWorker: {register: async (url, options) => { registered = {url, options}; }},
    },
  }));
  return {listeners, element, registered};
}
const chrome = installHarness();
assert.equal(chrome.registered.url, '/sw.js');
assert.equal(chrome.registered.options.updateViaCache, 'none');
assert.equal(chrome.element('#install-app').hidden, true);
let prompted = false, prevented = false;
chrome.listeners.beforeinstallprompt({
  preventDefault() { prevented = true; },
  async prompt() { prompted = true; },
  userChoice: Promise.resolve({outcome: 'accepted'}),
});
assert.equal(prevented, true);
assert.equal(chrome.element('#install-app').hidden, false);
await chrome.element('#install-app').listeners.click();
assert.equal(prompted, true);
chrome.listeners.appinstalled();
assert.equal(chrome.element('#install-app').hidden, true);
const iphone = installHarness(true);
assert.equal(iphone.element('#install-app').hidden, false);
await iphone.element('#install-app').listeners.click();
assert.equal(iphone.element('#install-help').open, true);
iphone.element('#close-install-help').listeners.click();
assert.equal(iphone.element('#install-help').open, false);
assert.equal(installHarness(true, true).element('#install-app').hidden, true);
console.log('PASS native install prompt, iPhone instructions and installed-app button visibility');
