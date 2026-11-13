export const SESSION_COOKIE_NAME='__Host-medicine-session';
export const SESSION_SECONDS=30*24*60*60;
const DAY=24*60*60*1000;
export function sessionToken(cookie=''){
 const entries=cookie.split(';').map(value=>value.trim()).filter(value=>value.startsWith(SESSION_COOKIE_NAME+'='));
 if(entries.length!==1)return null;
 const token=entries[0].slice(SESSION_COOKIE_NAME.length+1);
 return /^[a-f0-9]{64}$/.test(token)?token:null;
}
export const sessionCookie=(token,seconds=SESSION_SECONDS)=>`${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Strict`;
export async function sessionHash(token){
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export async function readSession(request,db){
 const token=sessionToken(request.headers.get('Cookie')||'');if(!token)return null;
 const hash=await sessionHash(token),now=new Date().toISOString();
 const saved=await db.prepare('SELECT actor,email,name,expires_at FROM auth_sessions WHERE token_hash=? AND expires_at>?').bind(hash,now).first();
 return saved?{...saved,token,hash}:null;
}
export async function createSession(db,identity,isOwner,oldToken){
 const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join('');
 const hash=await sessionHash(token),now=new Date().toISOString(),expires=new Date(Date.now()+SESSION_SECONDS*1000).toISOString();
 const statements=[db.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').bind(now)];
 if(oldToken)statements.push(db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').bind(await sessionHash(oldToken)));
 // Check approval status in the same transaction as session creation.
 statements.push(db.prepare("INSERT INTO auth_sessions(token_hash,actor,email,name,expires_at) SELECT ?,?,?,?,? WHERE ?=1 OR EXISTS(SELECT 1 FROM staff_access WHERE email=? AND status<>'revoked')").bind(hash,identity.actor,identity.email,identity.name||identity.email,expires,isOwner?1:0,identity.email));
 const result=await db.batch(statements);
 return result.at(-1).meta.changes===1?sessionCookie(token):null;
}
export async function renewSession(db,saved){
 if(Date.parse(saved.expires_at)>Date.now()+SESSION_SECONDS*1000-DAY)return null;
 const result=await db.prepare('UPDATE auth_sessions SET expires_at=? WHERE token_hash=? AND expires_at>?').bind(new Date(Date.now()+SESSION_SECONDS*1000).toISOString(),saved.hash,new Date().toISOString()).run();
 return result.meta.changes===1?sessionCookie(saved.token):null;
}
export async function deleteSession(request,db){
 const token=sessionToken(request.headers.get('Cookie')||'');
 if(token)await db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').bind(await sessionHash(token)).run();
 return sessionCookie('',0);
}
