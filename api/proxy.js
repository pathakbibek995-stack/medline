import {SESSION_COOKIE_NAME,sessionToken} from '../worker/auth/session.js';

export const config = {api: {bodyParser: false}};

const jsonError = (res, status, error) => res.status(status).json({error});

export default async function handler(req, res) {
  const workerUrl = process.env.CLOUDFLARE_WORKER_URL;
  const appOrigin = process.env.APP_ORIGIN;
  const authorization = req.headers.authorization;

  if (!workerUrl || !appOrigin) return jsonError(res, 503, 'The API proxy is not configured.');
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) return jsonError(res, 405, 'Method not allowed.');

  let origin;
  try {
    const configuredOrigin = new URL(appOrigin);
    if (configuredOrigin.protocol !== 'https:' || configuredOrigin.username || configuredOrigin.password ||
        configuredOrigin.pathname !== '/' || configuredOrigin.search || configuredOrigin.hash) {
      return jsonError(res, 503, 'The application origin is invalid.');
    }
    origin = configuredOrigin.origin;
  } catch {
    return jsonError(res, 503, 'The application origin is invalid.');
  }
  if (req.method !== 'GET' && req.headers.origin !== origin) return jsonError(res, 403, 'Request origin is not allowed.');
  const incoming=new URL(req.url,origin);
  if(incoming.pathname==='/api/proxy'){
    const route=incoming.searchParams.get('_medicine_path')||'';
    if(!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(route))return jsonError(res,404,'Not found.');
    incoming.pathname='/api/'+route;
  }
  incoming.searchParams.delete('_medicine_path');
  const savedToken=sessionToken(req.headers.cookie||'');
  const logout=incoming.pathname==='/api/logout'&&req.method==='POST';
  if (authorization !== undefined && (typeof authorization !== 'string' || !/^Bearer [^.]+\.[^.]+\.[^.]+$/.test(authorization))) {
    return jsonError(res, 401, 'Sign in with an approved Google account.');
  }
  if(!authorization&&!savedToken&&!logout)return jsonError(res,401,'Sign in with an approved Google account.');

  let upstream;
  try {
    const base = new URL(workerUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
      return jsonError(res, 503, 'The Cloudflare Worker URL is invalid.');
    }
    if (!incoming.pathname.startsWith('/api/')) return jsonError(res, 404, 'Not found.');
    upstream = new URL(incoming.pathname + incoming.search, base);
  } catch {
    return jsonError(res, 503, 'The API proxy is not configured correctly.');
  }

  const headers = {
    Origin: origin,
  };
  if(authorization)headers.Authorization=authorization;
  if(savedToken)headers.Cookie=SESSION_COOKIE_NAME+'='+savedToken;
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  if (req.headers['idempotency-key']) headers['Idempotency-Key'] = req.headers['idempotency-key'];

  let body;
  if (req.method !== 'GET') {
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length >= 32768) return jsonError(res, 413, 'Request is too large.');
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  }

  try {
    const response = await fetch(upstream, {method: req.method, headers, body});
    const responseBody = Buffer.from(await response.arrayBuffer());
    res.status(response.status);
    res.setHeader('Content-Type', response.headers.get('Content-Type') || 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const cookies=response.headers.getSetCookie?.()||[];
    if(cookies.length)res.setHeader('Set-Cookie',cookies);
    return res.send(responseBody);
  } catch (error) {
    console.error('Cloudflare Worker proxy failed', error.message);
    return jsonError(res, 503, 'The API could not be reached. Please retry.');
  }
}
