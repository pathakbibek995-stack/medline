import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {pwaAssets} from './pwa-assets.mjs';

await rm('public', {recursive: true, force: true});
await mkdir('public', {recursive: true});
const clientID = (process.env.GOOGLE_CLIENT_ID || '').trim();
if (!/^[0-9]+-[a-z0-9-]+\.apps\.googleusercontent\.com$/i.test(clientID)) {
  throw new Error('GOOGLE_CLIENT_ID is not a valid Google OAuth web client ID.');
}
const html = await readFile('worker/app.html', 'utf8');
await writeFile('public/index.html', html.replace('__GOOGLE_CLIENT_ID__', clientID));
for (const [path, asset] of Object.entries(await pwaAssets())) {
  const output = 'public' + path;
  await mkdir(dirname(output), {recursive: true});
  await writeFile(output, Buffer.from(asset.body, 'base64'));
}
console.log('Built Vercel static frontend.');
