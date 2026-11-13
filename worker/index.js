import {verifyGoogleIdentity} from './auth/google.js';
import {readSession,createSession,renewSession,deleteSession,sessionToken} from './auth/session.js';
const MAX_MONEY = 1000000000000;
const json = (data, status = 200) => Response.json(data, {status, headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
class APIError extends Error { constructor(message,status=400){super(message);this.status=status;} }
const assert = (ok,message,status=400) => {if(!ok) throw new APIError(message,status);};
function integer(value,name,min=0,max=MAX_MONEY){assert(Number.isSafeInteger(value)&&value>=min&&value<=max,`${name} must be a whole number between ${min} and ${max}.`);return value;}
function clean(value,name,max=150,optional=false){assert(typeof value==='string',`${name} is required.`);const s=value.trim();assert((optional||s.length>0)&&s.length<=max,`${name} must be ${optional?'0':'1'}–${max} characters.`);return s;}
export const nepalDay = (date=new Date())=>new Date(date.getTime()+345*60000).toISOString().slice(0,10);
const uuid=()=>crypto.randomUUID();
async function fingerprint(path,body,actor){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([path,body,actor]))))).map(x=>x.toString(16).padStart(2,'0')).join('');}
const accessKeys=new Map();
function decodeBase64Url(value){
 const normalized=value.replace(/-/g,'+').replace(/_/g,'/'), padded=normalized+'='.repeat((4-normalized.length%4)%4);
 return Uint8Array.from(atob(padded),character=>character.charCodeAt(0));
}
function jwtParts(token){
 const parts=token.split('.');assert(parts.length===3,'Sign in with an approved Google account.',401);
 try{return {parts,header:JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0]))),claims:JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])))};}catch{throw new APIError('The identity provider returned an invalid token.',401);}
}
async function accessClaims(token,teamDomain,audience){
 const issuer='https://'+teamDomain,{parts,header,claims}=jwtParts(token);
 assert(header.alg==='RS256'&&typeof header.kid==='string','Cloudflare Access token is not supported.',401);
 let cached=accessKeys.get(issuer);
 if(!cached||cached.expires<Date.now()){
  const response=await fetch(issuer+'/cdn-cgi/access/certs');
  assert(response.ok,'Could not verify Cloudflare Access identity.',503);
  const document=await response.json();
  assert(Array.isArray(document.keys),'Cloudflare Access signing keys are unavailable.',503);
  cached={keys:document.keys,expires:Date.now()+3600000};accessKeys.set(issuer,cached);
 }
 const jwk=cached.keys.find(key=>key.kid===header.kid&&key.kty==='RSA'&&key.use==='sig');
 assert(jwk,'Cloudflare Access signing key was not found.',401);
 let valid=false;
 try{const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);valid=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,decodeBase64Url(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1]));}catch{valid=false;}
 assert(valid,'Cloudflare Access identity token signature is invalid.',401);
 const now=Math.floor(Date.now()/1000),audiences=Array.isArray(claims.aud)?claims.aud:[claims.aud];
 assert(claims.iss===issuer&&audiences.includes(audience),'This Cloudflare Access token is for a different application.',401);
 assert(Number.isFinite(claims.exp)&&claims.exp>now&&(!Number.isFinite(claims.nbf)||claims.nbf<=now),'Cloudflare Access identity token has expired or is not active.',401);
 assert(typeof claims.sub==='string'&&claims.sub.length>0&&typeof claims.email==='string'&&claims.email.length>0,'Cloudflare Access identity is incomplete.',401);
 return {actor:claims.sub,email:claims.email};
}
async function googleIdentity(token,clientID){
 try{return await verifyGoogleIdentity(token,clientID);}catch{throw new APIError('Google sign-in could not be verified. Sign in again.',401);}
}
export async function api(request,env){
 const context={};
 const response=await handleAPI(request,env,context);
 if(context.saved&&response.ok){const cookie=await renewSession(env.DB,context.saved);if(cookie)response.headers.append('Set-Cookie',cookie);}
 return response;
}
async function handleAPI(request,env,context){
 const u=new URL(request.url), p=u.pathname, method=request.method;
 if(method!=='GET'){
  assert(method==='POST'||method==='PATCH'||method==='DELETE','Method not allowed.',405);
  const allowedOrigin=env.APP_ORIGIN?new URL(env.APP_ORIGIN).origin:u.origin;
  assert(request.headers.get('Origin')===allowedOrigin,'Request origin is not allowed.',403);
  assert((request.headers.get('Content-Type')||'').startsWith('application/json'),'Use JSON for requests.',415);
  assert(Number(request.headers.get('Content-Length')||0)<32768,'Request is too large.',413);
 }
 if(p==='/api/logout'&&method==='POST'){
  assert(env.DB,'Online database is unavailable.',503);
  const response=json({ok:true});response.headers.set('Set-Cookie',await deleteSession(request,env.DB));return response;
 }
 let actor,email,name;
 if(env.GOOGLE_CLIENT_ID){
  const authorization=request.headers.get('Authorization')||'';
  let identity;
  if(authorization){assert(authorization.startsWith('Bearer '),'Sign in with Google to continue.',401);identity=await googleIdentity(authorization.slice(7),env.GOOGLE_CLIENT_ID);}
  else{assert(sessionToken(request.headers.get('Cookie')||''),'Sign in with Google to continue.',401);assert(env.DB,'Online database is unavailable.',503);identity=await readSession(request,env.DB);assert(identity,'Sign in with Google to continue.',401);context.saved=identity;}
  actor=identity.actor;email=identity.email;name=identity.name;
 }else if(env.CF_ACCESS_TEAM_DOMAIN||env.CF_ACCESS_AUD){
  assert(env.CF_ACCESS_TEAM_DOMAIN&&env.CF_ACCESS_AUD,'Cloudflare Access identity is not fully configured.',503);
  assert(/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(env.CF_ACCESS_TEAM_DOMAIN),'Cloudflare Access team domain is invalid.',503);
  const token=request.headers.get('Cf-Access-Jwt-Assertion');
  assert(token,'Sign in through the approved Cloudflare Access application.',401);
  const identity=await accessClaims(token,env.CF_ACCESS_TEAM_DOMAIN,env.CF_ACCESS_AUD);actor=identity.actor;email=identity.email;name=identity.name;
 }else{
  assert(env.SITES_AUTH_ENABLED==='true','Authentication has not been configured.',503);
  actor=request.headers.get('oai-authenticated-user-id');email=request.headers.get('oai-authenticated-user-email');
  assert(actor&&email,'Sign in with ChatGPT to continue.',401);
 }
 assert(env.OWNER_EMAIL,'Owner identity has not been configured.',503);
 const normalizedEmail=email.trim().toLowerCase();
 let role=normalizedEmail===env.OWNER_EMAIL.trim().toLowerCase()?'owner':'cashier';
 if(env.GOOGLE_CLIENT_ID&&role!=='owner'){
  assert(env.DB,'Online database is unavailable.',503);
  const now=new Date().toISOString();
  await env.DB.prepare("INSERT INTO staff_access(email,name,status,created_at,updated_at) VALUES(?,?,'pending',?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name").bind(normalizedEmail,name||email,now,now).run();
  const access=await env.DB.prepare('SELECT role,status FROM staff_access WHERE email=?').bind(normalizedEmail).first();
  role=access.status==='approved'?access.role:access.status;
 }else if(role!=='owner'){
  const staffEmails=new Set((env.STAFF_EMAILS||'').split(',').map(value=>value.trim().toLowerCase()).filter(Boolean));
  assert(staffEmails.has(normalizedEmail),'This account has not been approved for this shop.',403);
 }
 const canManageInventory=role==='owner'||role==='admin',canManageAccess=role==='owner',canViewReports=role==='owner',canEditStock=role==='owner';
 const owner=()=>assert(canManageInventory,'Only an approved inventory manager can manage stock or purchase records.',403);
 if(p==='/api/session'&&method==='POST'){
  assert(env.GOOGLE_CLIENT_ID&&request.headers.get('Authorization')?.startsWith('Bearer '),'Sign in with Google to save this login.',401);
  assert(env.DB,'Online database is unavailable.',503);
  assert(role!=='revoked','Your access has been revoked. Contact Pathak Bibek.',403);
  const cookie=await createSession(env.DB,{actor,email:normalizedEmail,name},role==='owner',sessionToken(request.headers.get('Cookie')||''));
  assert(cookie,'Your access has been revoked. Contact Pathak Bibek.',403);
  const response=json({ok:true});response.headers.set('Set-Cookie',cookie);return response;
 }
 if(p==='/api/me'&&method==='GET')return json({role,name:name||email,email:normalizedEmail,timeZone:'Asia/Kathmandu',canManageInventory,canManageAccess,canViewReports,canEditStock});
 assert(!['pending','revoked'].includes(role),role==='revoked'?'Your access has been revoked. Contact Pathak Bibek.':'Your account is waiting for approval from Pathak Bibek.',403);
 assert(env.DB,'Online database is unavailable. Please try again.',503);
 const db=env.DB, query=(sql,...args)=>db.prepare(sql).bind(...args);
 if(p==='/api/access'){
  assert(canManageAccess,'Only Pathak Bibek can approve accounts or change access.',403);
  if(method==='GET')return json((await query("SELECT email,name,role,status,created_at,updated_at FROM staff_access ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,updated_at DESC").all()).results);
  assert(method==='POST','Method not allowed.',405);
  const raw=await request.text();assert(raw.length<4096,'Request is too large.',413);
  let body;try{body=JSON.parse(raw);}catch{throw new APIError('Use a valid access request.');}
  assert(body&&typeof body==='object'&&!Array.isArray(body),'Use a valid access request.');
  const target=clean(body.email,'Email',254).toLowerCase();assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target),'Enter a complete email address.');
  assert(target!==env.OWNER_EMAIL.trim().toLowerCase(),'The owner account cannot be changed or revoked.',403);
  assert(['admin','worker'].includes(body.role),'Choose Admin or Worker.');
  assert(['approved','revoked'].includes(body.status),'Choose approval or revocation.');
  const now=new Date().toISOString();
  const updates=[
   query('INSERT INTO staff_access(email,role,status,created_at,updated_at,updated_by) VALUES(?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET role=excluded.role,status=excluded.status,updated_at=excluded.updated_at,updated_by=excluded.updated_by',target,body.role,body.status,now,now,actor),
   query('INSERT INTO access_audit(id,email,role,status,actor,created_at) VALUES(?,?,?,?,?,?)',uuid(),target,body.role,body.status,actor,now),
  ];
  if(body.status==='revoked')updates.push(query('DELETE FROM auth_sessions WHERE email=?',target));
  await db.batch(updates);
  return json({email:target,role:body.role,status:body.status});
 }
 if(p==='/api/medicines'&&method==='GET'){
  const q=(u.searchParams.get('q')||'').slice(0,150);
  const includeDeleted=u.searchParams.get('include_deleted')==='true';if(includeDeleted)assert(canEditStock,'Only Pathak Bibek can view deleted stock.',403);
  const rows=await query('SELECT id,name,mrp_paisa,quantity,deleted_at FROM medicines WHERE '+(includeDeleted?'':'deleted_at IS NULL AND ')+ 'instr(lower(name),lower(?))>0 ORDER BY name',q).all();return json(rows.results);
 }
 if(p==='/api/patients'&&method==='GET'){
  const q=(u.searchParams.get('q')||'').slice(0,150),scope=canViewReports?'':' AND actor=?';
  const args=canViewReports?[q]:[q,actor];
  return json((await query("SELECT patient_name,contact_number FROM (SELECT patient_name,contact_number,ROW_NUMBER() OVER(PARTITION BY lower(patient_name) ORDER BY created_at DESC,id DESC) AS position FROM bills WHERE trim(patient_name) <> '' AND instr(lower(patient_name),lower(?))>0"+scope+") WHERE position=1 ORDER BY lower(patient_name)",...args).all()).results);
 }
 if(p==='/api/purchases'&&method==='GET') {owner();return json((await query('SELECT * FROM stock_purchases WHERE (? = \'\' OR medicine_id = ?) ORDER BY created_at DESC LIMIT 300',u.searchParams.get('medicine_id')||'',u.searchParams.get('medicine_id')||'').all()).results);}
 if(p==='/api/bills'&&method==='GET'){
  const q=(u.searchParams.get('q')||'').slice(0,150); const offset=Number(u.searchParams.get('offset')||0);integer(offset,'Offset',0,1000000);
  const scope=canViewReports?'':' AND actor=?';
  const args=canViewReports?[q,u.searchParams.get('due')||'',offset]:[q,u.searchParams.get('due')||'',actor,offset];
  return json((await query("SELECT *, total_paisa-paid_paisa AS due_paisa FROM bills WHERE instr(lower(patient_name),lower(?))>0 AND (? <> 'true' OR total_paisa>paid_paisa)"+scope+" ORDER BY created_at DESC, id DESC LIMIT 51 OFFSET ?",...args).all()).results);
 }
 if(p==='/api/dues'&&method==='GET'){
  const q=(u.searchParams.get('q')||'').slice(0,150),scope=canViewReports?'':' AND actor=?';
  const args=canViewReports?[q]:[q,actor];
  return json((await query("WITH unpaid AS (SELECT *,FIRST_VALUE(contact_number) OVER(PARTITION BY lower(patient_name),CASE WHEN trim(patient_name)='' THEN id ELSE '' END ORDER BY created_at DESC,id DESC) AS latest_contact FROM bills WHERE total_paisa>paid_paisa AND instr(lower(patient_name),lower(?))>0"+scope+") SELECT MIN(patient_name) AS patient_name,MAX(latest_contact) AS contact_number,CASE WHEN trim(patient_name)='' THEN MIN(id) END AS bill_id,SUM(total_paisa-paid_paisa) AS due_paisa,COUNT(*) AS unpaid_bills,MIN(created_at) AS oldest_bill FROM unpaid GROUP BY lower(patient_name),CASE WHEN trim(patient_name)='' THEN id ELSE '' END ORDER BY due_paisa DESC,lower(patient_name) ASC,bill_id ASC",...args).all()).results);
 }
 const detail=p.match(/^\/api\/bills\/([a-z0-9-]+)$/i);
 if(detail&&method==='GET'){
  const bill=await query('SELECT *,total_paisa-paid_paisa AS due_paisa FROM bills WHERE id=?',detail[1]).first();assert(bill&&(canViewReports||bill.actor===actor),'Bill not found.',404);
  const [items,payments]=await Promise.all([query('SELECT * FROM bill_items WHERE bill_id=?',bill.id).all(),query('SELECT * FROM payments WHERE bill_id=? ORDER BY created_at,id',bill.id).all()]);return json({...bill,items:items.results,payments:payments.results});
 }
 if(p==='/api/dashboard'&&method==='GET'){
  assert(canViewReports,'Only Pathak Bibek can view financial reports.',403);const month=u.searchParams.get('month')||nepalDay().slice(0,7);assert(/^\d{4}-(0[1-9]|1[0-2])$/.test(month),'Choose a valid month.');
  const today=nepalDay();const r=await db.batch([
   query("SELECT COALESCE(SUM(total_paisa),0) AS sales, COUNT(*) AS count FROM bills WHERE is_opening_balance=0 AND substr(datetime(created_at,'+345 minutes'),1,10)=?",today),
   query("SELECT COALESCE(SUM(total_paisa),0) AS sales, COUNT(*) AS count FROM bills WHERE is_opening_balance=0 AND substr(datetime(created_at,'+345 minutes'),1,7)=?",month),
   query("SELECT COALESCE(SUM(amount_paisa),0) AS collected FROM payments WHERE substr(datetime(created_at,'+345 minutes'),1,7)=?",month),
   query('SELECT COALESCE(SUM(total_paisa-paid_paisa),0) AS due, COUNT(CASE WHEN total_paisa>paid_paisa THEN 1 END) AS count FROM bills'),
   query('SELECT COALESCE(SUM(cost_paisa),0) AS cost FROM stock_purchases WHERE substr(purchase_date,1,7)=?',month),
   query("SELECT substr(datetime(created_at,'+345 minutes'),9,2) AS day,SUM(total_paisa) AS sales FROM bills WHERE is_opening_balance=0 AND substr(datetime(created_at,'+345 minutes'),1,7)=? GROUP BY day",month),
   query('SELECT COUNT(*) AS medicines, COALESCE(SUM(quantity),0) AS units, COUNT(CASE WHEN quantity=0 THEN 1 END) AS out_of_stock FROM medicines WHERE deleted_at IS NULL'),
   query('SELECT *,total_paisa-paid_paisa AS due_paisa FROM bills WHERE is_opening_balance=0 ORDER BY created_at DESC LIMIT 5')
  ]);return json({today:r[0].results[0],month:r[1].results[0],collections:r[2].results[0].collected,outstanding:r[3].results[0],purchase_cost:r[4].results[0].cost,days:r[5].results,stock:r[6].results[0],recent:r[7].results,period:month});
 }
 const price=p.match(/^\/api\/medicines\/([a-z0-9-]+)$/i), payment=p.match(/^\/api\/bills\/([a-z0-9-]+)\/payments$/i), patientPayment=p==='/api/patient-payments'&&method==='POST', openingDue=p==='/api/opening-dues'&&method==='POST';
 assert((p==='/api/receipts'&&method==='POST')||(p==='/api/bills'&&method==='POST')||(price&&(method==='PATCH'||method==='DELETE'))||(payment&&method==='POST')||patientPayment||openingDue,'Endpoint not found.',404);
 if(p==='/api/receipts')owner();
 if(price)assert(canEditStock,'Only Pathak Bibek can edit or delete stock.',403);
 if(openingDue)assert(canManageInventory,'Only an approved inventory manager can record pre-existing dues.',403);
 if(payment&&method==='POST'){
  const bill=await query('SELECT id,actor FROM bills WHERE id=?',payment[1]).first();
  assert(bill&&(canViewReports||bill.actor===actor),'Bill not found.',404);
 }
 const raw=await request.text();assert(raw.length<32768,'Request is too large.',413);let body;try{body=JSON.parse(raw);}catch{throw new APIError('Request must contain valid JSON.');}assert(body&&typeof body==='object'&&!Array.isArray(body),'Request must be an object.');
 const key=request.headers.get('Idempotency-Key');assert(key&&/^[a-zA-Z0-9_-]{16,100}$/.test(key),'A valid submission key is required.');
 const hash=await fingerprint(p+(method==='DELETE'?'#DELETE':''),body,actor), resultID=uuid(), now=new Date().toISOString();
 const previous=async()=>{const op=await query('SELECT * FROM operations WHERE key=?',key).first();if(!op)return null;assert(op.fingerprint===hash,'This submission key was already used for different entries. Start a new submission.',409);return json({id:op.result_id,replayed:true});};
 const prior=await previous();if(prior)return prior;
 const statements=[query('INSERT INTO operations(key,fingerprint,result_id,actor,created_at) VALUES(?,?,?,?,?)',key,hash,resultID,actor,now)];
 if(p==='/api/receipts'){
  const name=clean(body.name,'Medicine name'), mrp=integer(body.mrp_paisa,'MRP',1,1000000000), qty=integer(body.quantity,'Quantity',1,1000000), cost=integer(body.cost_paisa,'Purchase cost');
  const day=clean(body.purchase_date,'Purchase date',10);assert(/^\d{4}-\d{2}-\d{2}$/.test(day)&&!isNaN(Date.parse(day))&&new Date(day).toISOString().slice(0,10)===day&&day<=nepalDay(),'Choose a valid purchase date, no later than today.');
  const existing=await query('SELECT id,mrp_paisa,deleted_at FROM medicines WHERE name=? COLLATE NOCASE',name).first();
  if(existing&&!canEditStock){assert(!existing.deleted_at,'Only Pathak Bibek can restore deleted stock.',403);assert(existing.mrp_paisa===mrp,'Only Pathak Bibek can change an existing medicine’s MRP.',403);}
  if(existing&&body.confirm_existing!==true){
   const replay=await previous();if(replay)return replay;
   throw new APIError('This medicine already exists. Confirm that you want to add another delivery to its stock.',409);
  }
  // An unconfirmed concurrent first receipt must not silently replenish existing stock.
  statements.push(query('INSERT INTO medicines(id,name,mrp_paisa,created_at) VALUES(?,?,?,?)'+(body.confirm_existing===true?(canEditStock?' ON CONFLICT(name) DO UPDATE SET mrp_paisa=excluded.mrp_paisa,deleted_at=NULL':' ON CONFLICT(name) DO NOTHING'):''),uuid(),name,mrp,now));
  statements.push(query('INSERT INTO stock_purchases(id,medicine_id,medicine_name,quantity,cost_paisa,purchase_date,created_at,actor) SELECT ?,id,name,CASE WHEN deleted_at IS NULL THEN ? ELSE 0 END,?,?,?,? FROM medicines WHERE name=?',resultID,qty,cost,day,now,actor,name));
 } else if(openingDue){
  const patient=clean(body.patient_name,'Patient / guardian name'),disease=clean(body.disease||'','Disease',300,true),amount=integer(body.amount_paisa,'Existing due',1),contact=clean(body.contact_number??'','Contact number',40,true);
  statements.push(query('INSERT INTO bills(id,patient_name,disease,total_paisa,paid_paisa,created_at,actor,is_opening_balance,contact_number) VALUES(?,?,?,?,0,?,?,1,?)',resultID,patient,disease,amount,now,actor,contact));
 } else if(price){
  const med=await query('SELECT * FROM medicines WHERE id=? AND deleted_at IS NULL',price[1]).first();assert(med,'Medicine not found.',404);
  const name=body.name===undefined?med.name:clean(body.name,'Medicine name'),mrp=body.mrp_paisa===undefined?med.mrp_paisa:integer(body.mrp_paisa,'MRP',1,1000000000),quantity=body.quantity===undefined?med.quantity:integer(body.quantity,'Available quantity',0,1000000000);
  const expectedName=body.expected_name===undefined?med.name:clean(body.expected_name,'Reviewed medicine name'),expectedMRP=body.expected_mrp_paisa===undefined?med.mrp_paisa:integer(body.expected_mrp_paisa,'Reviewed MRP',1,1000000000),expectedQuantity=body.expected_quantity===undefined?med.quantity:integer(body.expected_quantity,'Reviewed quantity',0,1000000000);
  statements.push(query('INSERT INTO stock_changes(id,medicine_id,action,name,mrp_paisa,quantity,expected_name,expected_mrp_paisa,expected_quantity,created_at,actor) VALUES(?,?,?,?,?,?,?,?,?,?,?)',resultID,med.id,method==='DELETE'?'delete':'update',method==='DELETE'?med.name:name,method==='DELETE'?med.mrp_paisa:mrp,quantity,expectedName,expectedMRP,expectedQuantity,now,actor));
 } else if(payment){
  integer(body.amount_paisa,'Payment',1);assert(await query('SELECT id FROM bills WHERE id=?',payment[1]).first(),'Bill not found.',404);
  statements.push(query('INSERT INTO payments(id,bill_id,amount_paisa,created_at,actor) VALUES(?,?,?,?,?)',resultID,payment[1],body.amount_paisa,now,actor));
 } else if(patientPayment){
  const patient=clean(body.patient_name,'Patient / guardian name'),amount=integer(body.amount_paisa,'Payment',1);
  const scope=canViewReports?'':' AND actor=?',args=canViewReports?[patient]:[patient,actor];
  const bills=(await query('SELECT id,created_at,total_paisa-paid_paisa AS due_paisa FROM bills WHERE patient_name=? COLLATE NOCASE AND total_paisa>paid_paisa'+scope+' ORDER BY created_at ASC,id ASC LIMIT 101',...args).all()).results;
  assert(bills.length>0,'No outstanding bills found for this patient.',404);
  assert(bills.length<=100,'This patient has too many unpaid bills for one collection. Collect payments against individual bills instead.',409);
  const totalDue=bills.reduce((sum,bill)=>sum+bill.due_paisa,0);assert(Number.isSafeInteger(totalDue),'Patient balance exceeds the supported limit.',400);
  assert(amount<=totalDue,'Payment exceeds this patient’s outstanding balance.',409);
  let remaining=amount;const allocations=[];
  for(const bill of bills){
   if(!remaining)break;
   const allocated=Math.min(remaining,bill.due_paisa);
   statements.push(query('INSERT INTO payments(id,bill_id,amount_paisa,created_at,actor) VALUES(?,?,?,?,?)',uuid(),bill.id,allocated,now,actor));
   allocations.push({bill_id:bill.id,amount_paisa:allocated});remaining-=allocated;
  }
  try{await db.batch(statements);}catch(error){const prior=await previous();if(prior)return prior;
   const msg=String(error.message);if(msg.includes('OVERPAYMENT'))throw new APIError('The patient balance changed while collecting. Refresh dues and try again.',409);
   if(msg.includes('CHECK constraint'))throw new APIError('The resulting amount exceeds the supported limit.',400);
   throw error;
  }
  return json({patient_name:patient,amount_paisa:amount,allocations},201);
 } else {
  const patient=clean(body.patient_name??'','Patient / guardian name',150,true), disease=clean(body.disease||'','Disease',300,true),contact=clean(body.contact_number??'','Contact number',40,true);integer(body.amount_paid_paisa,'Payment');
  assert(Array.isArray(body.items)&&body.items.length>0&&body.items.length<=50,'Add between 1 and 50 medicines.');
  const seen=new Set();let total=0;
  for(const item of body.items){clean(item.medicine_id,'Medicine ID',100);assert(!seen.has(item.medicine_id),'Each medicine can only appear once per bill.');seen.add(item.medicine_id);integer(item.quantity,'Quantity',1,1000000);integer(item.mrp_paisa,'MRP',1,1000000000);total+=item.quantity*item.mrp_paisa;}
  integer(total,'MRP total',1);
  const due=body.due_paisa===undefined?Math.max(0,total-body.amount_paid_paisa):integer(body.due_paisa,'Amount to keep due');
  const netTotal=integer(body.amount_paid_paisa+due,'Bill total'),discount=Math.max(0,total-netTotal),additional=Math.max(0,netTotal-total);
  statements.push(query('INSERT INTO bills(id,patient_name,disease,created_at,actor,contact_number) VALUES(?,?,?,?,?,?)',resultID,patient,disease,now,actor,contact));
  for(const item of body.items){
   const med=await query('SELECT * FROM medicines WHERE id=?',item.medicine_id).first();assert(med&&!med.deleted_at,'A selected medicine no longer exists.',409);assert(med.mrp_paisa===item.mrp_paisa,'A medicine price has changed. Refresh stock and review the bill.',409);
   statements.push(query('INSERT INTO bill_items(id,bill_id,medicine_id,medicine_name,mrp_paisa,quantity) VALUES(?,?,?,?,?,?)',uuid(),resultID,med.id,med.name,item.mrp_paisa,item.quantity));
  }
  statements.push(query('UPDATE bills SET discount_paisa=?,additional_charge_paisa=?,total_paisa=? WHERE id=?',discount,additional,netTotal,resultID));
  if(body.amount_paid_paisa>0)statements.push(query('INSERT INTO payments(id,bill_id,amount_paisa,created_at,actor) VALUES(?,?,?,?,?)',uuid(),resultID,body.amount_paid_paisa,now,actor));
 }
 try{await db.batch(statements);}catch(error){const prior=await previous();if(prior)return prior;
  const msg=String(error.message);if(msg.includes('INSUFFICIENT_STOCK'))throw new APIError('Stock or price changed. Refresh stock and review quantities; nothing was saved.',409);
  if(msg.includes('OVERPAYMENT'))throw new APIError('Payment exceeds the remaining balance. Refresh the bill and try again.',409);
  if(msg.includes('STOCK_CHANGED'))throw new APIError('Stock changed while you were editing. Refresh stock and review the latest values.',409);
  if(msg.includes('UNIQUE constraint failed: medicines.name'))throw new APIError(p==='/api/receipts'?'This medicine now exists. Review matching medicines and confirm another stock delivery.':'Another medicine already uses that name. Choose a different name.',409);
  if(msg.includes('CHECK constraint'))throw new APIError('The resulting amount or stock quantity exceeds the supported limit.',400);
  throw error;
 }
 return json({id:resultID},201);
}
export default {async fetch(request,env){try{const path=new URL(request.url).pathname;if(path.startsWith('/api/'))return await api(request,env);if(env.WORKER_PROXY_ONLY!=='true'&&PWA_ASSETS[path]){const asset=PWA_ASSETS[path];return new Response(Uint8Array.from(atob(asset.body),c=>c.charCodeAt(0)),{headers:{'Content-Type':asset.type,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff',...(path==='/sw.js'?{'Service-Worker-Allowed':'/'}:{})}});}if(path!=='/'||env.WORKER_PROXY_ONLY==='true')return new Response('Not found',{status:404});return new Response(APP_HTML,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline' https://accounts.google.com; style-src 'self' 'unsafe-inline' https://accounts.google.com; img-src 'self' data: https://*.googleusercontent.com; connect-src 'self' https://accounts.google.com https://www.googleapis.com; frame-src https://accounts.google.com; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'"}});}catch(error){if(error instanceof APIError)return json({error:error.message},error.status);console.error('Request failed',error.message);return json({error:'The request could not be completed. Your entries are preserved. Please retry.'},503);}}};
const PWA_ASSETS = '__PWA_ASSETS__';
const APP_HTML = '__APP_HTML__';
