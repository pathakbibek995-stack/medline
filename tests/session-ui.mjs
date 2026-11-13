import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const source=readFileSync('worker/app.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
let saved=false,failLogout=false,account='owner@example.com',finishSlow;const requests=[];
function openApp(){
 const nodes=new Map(),node=key=>{
  if(!nodes.has(key))nodes.set(key,{value:'',innerHTML:'',textContent:'',style:{},isConnected:true,hidden:true,open:false,disabled:false,setAttribute(){},addEventListener(){},focus(){},close(){this.open=false;}});
  return nodes.get(key);
 };
 const context=createContext({
  console,URL,Date,Intl,crypto:globalThis.crypto,setTimeout:()=>1,clearTimeout(){},
  navigator:{onLine:false},location:{hash:''},MutationObserver:class{observe(){}},
  window:{addEventListener(){}},
  // Tokens must never be stored in browser-readable persistent storage.
  localStorage:new Proxy({},{get(){throw Error('Do not store login credentials in localStorage');}}),
  document:{querySelector:node,querySelectorAll:()=>[],activeElement:node('focus'),addEventListener(){}},
  fetch:async(path,options)=>{
   requests.push({path,options});
   if(path==='/api/slow')return new Promise(resolve=>{finishSlow=resolve;});
   if(path==='/api/session'){assert.equal(options.headers.Authorization,'Bearer valid-google-credential');saved=true;return Response.json({ok:true});}
   if(path==='/api/logout'){if(failLogout)return Response.json({error:'Try again'},{status:503});saved=false;return Response.json({ok:true});}
   if(!saved)return Response.json({error:'Sign in with Google'},{status:401});
   if(path==='/api/me')return Response.json({email:account,role:'owner',canManageInventory:true,canManageAccess:true,canViewReports:true});
   return Response.json([]);
  },
 });
 runInContext(source,context);
 runInContext('navigator.onLine=true;setConnection(true);navigate=async()=>{};',context);
 return {node,run:code=>runInContext(code,context)};
}
const first=openApp();await first.run("completeSignIn('valid-google-credential')");
assert.equal(first.run('user.email'),account);
assert.equal(requests.find(r=>r.path==='/api/session').options.method,'POST');
assert.equal(requests.find(r=>r.path==='/api/me').options.headers.Authorization,undefined);
assert.equal(requests.find(r=>r.path==='/api/me').options.credentials,'same-origin');
assert.equal(first.node('#sign-out').style.display,'inline-flex');
const requestCount=requests.length;
const reopened=openApp();await reopened.run('startApp()');
assert.equal(reopened.run('user.email'),account);
assert.equal(requests.slice(requestCount).filter(r=>r.path==='/api/session').length,0);
console.log('PASS Google credential is exchanged once; reopening restores the saved login with same-origin cookies');
failLogout=true;await reopened.run('signOut()');
assert.equal(reopened.run('user.email'),account);assert.equal(saved,true);
failLogout=false;await reopened.run('signOut()');
assert.equal(saved,false);assert.equal(reopened.run('user'),null);
const signedOut=openApp();await signedOut.run('startApp()');
assert.equal(signedOut.run('user'),null);assert.match(signedOut.node('#content').innerHTML,/Sign in with an approved Google account/);
console.log('PASS sign-out failure keeps the session usable, successful sign-out stays signed out after reopening');
saved=true;await signedOut.run('startApp()');
signedOut.run("billDraft.patient_name='Private draft';billDraft.paid='80'");
account='other@example.com';await signedOut.run('startApp()');
assert.equal(signedOut.run('billDraft.patient_name'),'');assert.equal(signedOut.run('user.email'),account);
saved=false;signedOut.node('#modal').open=true;
await assert.rejects(signedOut.run("api('/medicines')"),/Sign in with Google/);
assert.equal(signedOut.run('user'),null);assert.equal(signedOut.node('#modal').open,false);
console.log('PASS changing accounts clears the previous workspace, and an expired session closes records and shows sign-in');

saved=true;const late=openApp();await late.run('startApp()');
const pending=late.run("api('/slow')"),rejected=assert.rejects(pending,/Account changed/);
await late.run('signOut()');finishSlow(Response.json({private:'Old account records'}));await rejected;
assert.equal(late.run('user'),null);assert.match(late.node('#content').innerHTML,/Sign in with an approved Google account/);
console.log('PASS a late API response from the previous login cannot restore private records after sign-out');
