import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {readFileSync} from 'node:fs';
import worker from '../worker/index.js';
import proxy from '../api/proxy.js';
import {SESSION_COOKIE_NAME,SESSION_SECONDS,sessionHash} from '../worker/auth/session.js';
const mf=new Miniflare({modules:true,scriptPath:'dist/server/index.js',d1Databases:['DB'],compatibilityDate:'2024-12-01'});
const db=await mf.getD1Database('DB');
for(const file of ['0000_shop','0001_staff_access','0002_opening_balances','0003_bill_discounts','0004_saved_sessions','0005_patient_contact_stock_management'])for(const sql of readFileSync('drizzle/'+file+'.sql','utf8').split('--> statement-breakpoint'))await db.prepare(sql.trim()).run();
const env={DB:db,OWNER_EMAIL:'owner@example.com',GOOGLE_CLIENT_ID:'test-client.apps.googleusercontent.com',APP_ORIGIN:'https://shop.test',WORKER_PROXY_ONLY:'true'};
const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:Uint8Array.of(1,0,1),hash:'SHA-256'},true,['sign','verify']);
const jwk={...await crypto.subtle.exportKey('jwk',keys.publicKey),kid:'session-test',use:'sig',alg:'RS256'};
const originalFetch=globalThis.fetch,originalOrigin=process.env.APP_ORIGIN,originalWorker=process.env.CLOUDFLARE_WORKER_URL;
process.env.APP_ORIGIN=env.APP_ORIGIN;process.env.CLOUDFLARE_WORKER_URL='https://session-worker.test';
globalThis.fetch=async(input,options)=>{
 if(String(input)==='https://www.googleapis.com/oauth2/v3/certs')return Response.json({keys:[jwk]});
 if(String(input).startsWith('https://session-worker.test/'))return worker.fetch(new Request(input,options),env);
 throw Error('Unexpected outbound request');
};
const b64=value=>Buffer.from(value).toString('base64url');
async function googleToken(email,claims={}){const header=b64(JSON.stringify({alg:'RS256',kid:jwk.kid})),payload=b64(JSON.stringify({iss:'https://accounts.google.com',aud:env.GOOGLE_CLIENT_ID,sub:'google-'+email,email,email_verified:true,name:email,exp:Math.floor(Date.now()/1000)+300,...claims}));return header+'.'+payload+'.'+b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,new TextEncoder().encode(header+'.'+payload)));}
async function request(path,{method='GET',cookie,token,body,origin=env.APP_ORIGIN,headers={}}={}){
 const r=await worker.fetch(new Request(env.APP_ORIGIN+'/api'+path,{method,headers:{Origin:origin,'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID(),...(cookie?{Cookie:cookie}:{}),...(token?{Authorization:'Bearer '+token}:{}),...headers},body:method==='GET'?undefined:JSON.stringify(body||{})}),env);
 return {status:r.status,data:await r.json(),setCookie:r.headers.get('Set-Cookie')};
}
let count=0;const pass=(value,label)=>{assert.ok(value,label);count++;console.log('PASS',label);};
const jar=result=>result.setCookie.split(';')[0];
const ownerToken=await googleToken('owner@example.com');
async function changeAccess(email,role='worker',status='approved'){return request('/access',{method:'POST',token:ownerToken,body:{email,role,status}});}
try{
 for(const options of [{},{token:await googleToken('owner@example.com',{exp:1})},{token:await googleToken('owner@example.com',{aud:'wrong-client'})}])pass((await request('/session',{method:'POST',...options})).status===401,'Session creation requires a valid Google identity');
 pass((await request('/session',{method:'POST',token:ownerToken,origin:'https://attacker.test'})).status===403,'Cross-origin sign-in cannot create a cookie');
 const login=await request('/session',{method:'POST',token:ownerToken}),ownerCookie=jar(login);
 pass(login.status===200&&login.data.ok,'Verified Google login creates a saved session');
 pass(login.setCookie.includes('HttpOnly')&&login.setCookie.includes('Secure')&&login.setCookie.includes('SameSite=Strict')&&login.setCookie.includes('Path=/')&&login.setCookie.includes('Max-Age='+SESSION_SECONDS)&&!login.setCookie.includes('Domain='),'Saved login has a persistent host-only Secure HttpOnly SameSite cookie');
 pass(!JSON.stringify(login.data).includes(ownerCookie.split('=')[1]),'Session token is never returned to JavaScript in JSON');
 const stored=await db.prepare('SELECT * FROM auth_sessions').first(),raw=ownerCookie.split('=')[1];
 pass(stored.token_hash!==raw&&stored.token_hash===await sessionHash(raw),'Database stores only a digest of the random session token');
 const reopened=await request('/me',{cookie:ownerCookie});
 pass(reopened.status===200&&reopened.data.role==='owner','Reopening the app restores identity using only its saved cookie');
 pass((await request('/me',{cookie:ownerCookie,token:await googleToken('owner@example.com',{exp:1})})).status===401&&(await request('/me',{cookie:ownerCookie})).status===200,'Cookie session works independently of an expired Google credential');
 pass(!reopened.setCookie,'Normal repeated reads do not rewrite a fresh session');
 const oldExpiry=new Date(Date.now()+SESSION_SECONDS*1000-2*86400000).toISOString();
 await db.prepare('UPDATE auth_sessions SET expires_at=? WHERE token_hash=?').bind(oldExpiry,stored.token_hash).run();
 const renewed=await request('/me',{cookie:ownerCookie});
 pass(renewed.status===200&&renewed.setCookie?.includes('Max-Age='+SESSION_SECONDS),'Continued use renews the saved login after a day');
 pass((await db.prepare('SELECT expires_at FROM auth_sessions WHERE token_hash=?').bind(stored.token_hash).first()).expires_at>oldExpiry,'Renewal extends the server-side expiry too');
 const rotated=await request('/session',{method:'POST',token:ownerToken,cookie:ownerCookie}),rotatedCookie=jar(rotated);
 pass(rotatedCookie!==ownerCookie&&(await request('/me',{cookie:ownerCookie})).status===401,'Signing in again rotates and invalidates the old device cookie');
 const otherDevice=jar(await request('/session',{method:'POST',token:ownerToken}));
 pass((await request('/logout',{method:'POST',cookie:rotatedCookie,origin:'https://attacker.test'})).status===403,'Cross-origin logout is rejected');
 pass((await request('/me',{cookie:rotatedCookie})).status===200,'Rejected logout keeps the valid session intact');
 const logout=await request('/logout',{method:'POST',cookie:rotatedCookie});
 pass(logout.status===200&&logout.setCookie.includes('Max-Age=0'),'Sign out removes the saved cookie');
 pass((await request('/me',{cookie:rotatedCookie})).status===401&&(await request('/me',{cookie:otherDevice})).status===200,'Sign out invalidates this device without signing out another device');
 pass((await request('/logout',{method:'POST'})).status===200,'Sign out is safe to repeat without a cookie');
 await changeAccess('worker@example.com');
 const workerCookie=jar(await request('/session',{method:'POST',token:await googleToken('worker@example.com')}));
 pass((await request('/medicines',{cookie:workerCookie})).status===200&&(await request('/dashboard',{cookie:workerCookie})).status===403,'Saved worker session keeps its permitted role');
 await changeAccess('worker@example.com','admin');
 const adminSession=(await request('/me',{cookie:workerCookie})).data;
 pass(adminSession.role==='admin'&&!adminSession.canEditStock,'Inventory admin saved session cannot edit stock');
 pass((await request('/medicines/unknown',{method:'PATCH',cookie:workerCookie,body:{mrp_paisa:1}})).status===403,'Saved inventory-admin session cannot bypass owner-only stock editing');
 pass((await request('/medicines/unknown',{method:'DELETE',cookie:workerCookie})).status===403,'Saved inventory-admin session cannot bypass owner-only stock deletion');
 await changeAccess('worker@example.com','worker','revoked');
 pass((await request('/me',{cookie:workerCookie})).status===401,'Owner revocation invalidates saved logins immediately');
 await changeAccess('worker@example.com');
 pass((await request('/me',{cookie:workerCookie})).status===401,'Reapproval cannot revive a previously revoked cookie');
 const pendingCookie=jar(await request('/session',{method:'POST',token:await googleToken('pending@example.com')}));
 pass((await request('/me',{cookie:pendingCookie})).data.role==='pending'&&(await request('/medicines',{cookie:pendingCookie})).status===403,'Pending accounts retain a saved login without gaining shop access');
 await changeAccess('pending@example.com');
 pass((await request('/medicines',{cookie:pendingCookie})).status===200,'Approved pending account can continue without another Google login');
 await db.prepare('UPDATE auth_sessions SET expires_at=? WHERE token_hash=?').bind('2000-01-01T00:00:00.000Z',await sessionHash(otherDevice.split('=')[1])).run();
 pass((await request('/me',{cookie:otherDevice})).status===401,'Expired saved session cannot read shop records');
 for(const cookie of [SESSION_COOKIE_NAME+'='+'f'.repeat(64),SESSION_COOKIE_NAME+'=garbage',pendingCookie+'; '+pendingCookie])pass((await request('/me',{cookie})).status===401,'Unknown, malformed or duplicate session cookie is rejected');
 // Exercise the real Vercel proxy -> Worker -> D1 -> Set-Cookie boundary.
 function req(method,url,headers={},body='{}'){return {method,url,headers,async *[Symbol.asyncIterator](){if(method!=='GET')yield Buffer.from(body);}};}
 function res(){return {headers:{},statusCode:200,status(value){this.statusCode=value;return this;},setHeader(key,value){this.headers[key]=value;},json(value){this.body=JSON.stringify(value);return this;},send(value){this.body=String(value);return this;}};}
 const proxiedLogin=res();await proxy(req('POST','/api/session',{origin:env.APP_ORIGIN,authorization:'Bearer '+ownerToken,'content-type':'application/json'}),proxiedLogin);
 pass(proxiedLogin.statusCode===200&&proxiedLogin.headers['Set-Cookie']?.[0]?.includes('HttpOnly'),'Proxy delivers the session cookie from Worker to the browser');
 const proxiedCookie=proxiedLogin.headers['Set-Cookie'][0].split(';')[0],proxyMe=res();
 await proxy(req('GET','/api/me',{cookie:proxiedCookie+'; unrelated=ignored'}),proxyMe);
 pass(proxyMe.statusCode===200&&JSON.parse(proxyMe.body).role==='owner','Proxy restores a saved login without an Authorization header');
 const badWrite=res();await proxy(req('POST','/api/bills',{origin:'https://attacker.test',cookie:proxiedCookie,'content-type':'application/json'}),badWrite);
 pass(badWrite.statusCode===403,'Cookie-authenticated proxy writes still require the correct origin');
 const proxyLogout=res();await proxy(req('POST','/api/logout',{origin:env.APP_ORIGIN,cookie:proxiedCookie,'content-type':'application/json'}),proxyLogout);
 pass(proxyLogout.statusCode===200&&proxyLogout.headers['Set-Cookie'][0].includes('Max-Age=0'),'Proxy forwards logout cookie deletion');
 const afterLogout=res();await proxy(req('GET','/api/me',{cookie:proxiedCookie}),afterLogout);
 pass(afterLogout.statusCode===401,'Proxy cannot reuse a signed-out session');
 console.log(`${count} saved-session checks passed. Disposable local data only.`);
}finally{
 globalThis.fetch=originalFetch;
 if(originalOrigin===undefined)delete process.env.APP_ORIGIN;else process.env.APP_ORIGIN=originalOrigin;
 if(originalWorker===undefined)delete process.env.CLOUDFLARE_WORKER_URL;else process.env.CLOUDFLARE_WORKER_URL=originalWorker;
 await mf.dispose();
}
