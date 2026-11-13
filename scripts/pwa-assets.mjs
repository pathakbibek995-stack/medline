import {readFile} from 'node:fs/promises';

export async function pwaAssets() {
  const files = {
    '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
    '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
    '/install.js': ['install.js', 'text/javascript; charset=utf-8'],
    '/icons/icon-192.png': ['icons/icon-192.png', 'image/png'],
    '/icons/icon-512.png': ['icons/icon-512.png', 'image/png'],
    '/icons/maskable-512.png': ['icons/maskable-512.png', 'image/png'],
    '/icons/apple-touch-icon.png': ['icons/apple-touch-icon.png', 'image/png'],
  };
  const offlineHTML = await readFile('worker/pwa/no-connection.html', 'utf8');
  return Object.fromEntries(await Promise.all(Object.entries(files).map(async ([path, [file, type]]) => {
    let body = await readFile('worker/pwa/' + file);
    if (file === 'sw.js') body = Buffer.from(body.toString().replace("'__NO_CONNECTION_HTML__'", () => JSON.stringify(offlineHTML)));
    return [path, {body: body.toString('base64'), type}];
  })));
}
