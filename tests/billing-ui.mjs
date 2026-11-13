import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, runInContext} from 'node:vm';

// Exercise the actual UI handlers, including draft changes, searches and write payloads.
const handlers={},nodes=new Map(),requests=[];
function node(selector){
 if(selector==='#confirm-existing'&&!node('#existing-stock-warning').innerHTML.includes('id="confirm-existing"'))return null;
 if(!nodes.has(selector))nodes.set(selector,{
  value:'',innerHTML:'',textContent:'',style:{},dataset:{},isConnected:true,hidden:true,open:false,disabled:false,
  addEventListener(){},setAttribute(){},focus(){},scrollIntoView(){},showModal(){this.open=true;},close(){this.open=false;},
 });
 return nodes.get(selector);
}
const medicines=[{id:'med-a',name:'Paracetamol 500 mg',quantity:10,mrp_paisa:10000},{id:'med-b',name:'Syrup DV',quantity:4,mrp_paisa:2000},{id:'med-c',name:'Empty stock',quantity:0,mrp_paisa:3000}];
let failBill=true,receiptStatus=201;
const context=createContext({
 console,URL,Date,Intl,crypto:globalThis.crypto,setTimeout:()=>1,clearTimeout(){},
 navigator:{onLine:false},location:{hash:''},MutationObserver:class {observe(){}},
 window:{addEventListener(){}},
 document:{querySelector:node,querySelectorAll:()=>[],activeElement:node('focus'),addEventListener:(name,handler)=>{handlers[name]=handler;}},
 fetch:async(path,opts)=>{
  requests.push({path,...opts});
  if(path==='/api/patients')return Response.json([]);
  if(path.startsWith('/api/medicines'))return Response.json(opts.method?{ok:true}:medicines);
  if(path==='/api/receipts')return Response.json(receiptStatus===201?{id:'receipt-id'}:{error:'Response interrupted'},{status:receiptStatus});
  if(path==='/api/bills'&&failBill)return Response.json({error:'Temporary failure'},{status:503});
  throw Error('Unexpected request '+path);
 },
});
const source=readFileSync('worker/app.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
runInContext(source,context);
runInContext(`navigator.onLine=true;meds=${JSON.stringify(medicines)};billDraft.items=[{medicine_id:'med-a',quantity:1}];billDraft.paid='80';`,context);
const evaluate=code=>runInContext(code,context);
function input(id,value,dataset={}){const target=node('#'+id);target.id=id;target.value=value;Object.assign(target.dataset,dataset);handlers.input({target});}
async function click(dataset){await handlers.click({target:{closest:()=>({dataset,disabled:false})}});}
let total=evaluate('updateTotal()');
assert.equal(total.due,2000);assert.equal(node('#amount-due').value,'20.00');
input('amount-due','10');total=evaluate('updateTotal()');
assert.equal(total.discount,1000);assert.equal(total.due,1000);assert.equal(node('#net-total').textContent,'NPR 90.00');
input('amount-paid','85');total=evaluate('updateTotal()');
assert.equal(total.due,1000);assert.equal(total.discount,500,'Custom due stays fixed when payment changes');
await click({action:'no-due'});total=evaluate('updateTotal()');
assert.equal(total.due,0);assert.equal(total.discount,1500);assert.equal(node('#amount-due').value,'0.00');
await click({action:'full-due'});total=evaluate('updateTotal()');
assert.equal(total.due,1500);assert.equal(total.discount,0);assert.equal(node('#amount-due').value,'15.00');
input('amount-due','20');assert.equal(evaluate('updateTotal().amountError'),'');assert.equal(evaluate('updateTotal().additional'),500);
input('amount-paid','500');assert.equal(evaluate('updateTotal().additional'),42000);assert.equal(evaluate('updateTotal().amountError'),'');assert.equal(node('#amount-due').max,undefined);
input('amount-due','-1');
const beforeInvalid=requests.length;await evaluate('saveBill()');
assert.equal(requests.length,beforeInvalid,'Invalid chosen due cannot reach the API');
input('amount-due','10');input('amount-paid','80');await evaluate('saveBill()');
const first=requests.at(-1);assert.equal(first.path,'/api/bills');
assert.deepEqual(JSON.parse(first.body),{patient_name:'',contact_number:'',disease:'',amount_paid_paisa:8000,due_paisa:1000,items:[{medicine_id:'med-a',quantity:1,mrp_paisa:10000}]});
await evaluate('saveBill()');assert.equal(requests.at(-1).headers['Idempotency-Key'],first.headers['Idempotency-Key']);
assert.equal(evaluate('billDraft.due'),'10','Failed submission preserves chosen due');
console.log('PASS due editing, no-due/full-balance actions, validation, actual request payload and retry key');

await click({pickLine:'0'});assert.match(node('#modal').innerHTML,/Search medicines/);
input('medicine-search','sYrUp',{pickerLine:'0'});
assert.match(node('#medicine-options').innerHTML,/Syrup DV/);assert.doesNotMatch(node('#medicine-options').innerHTML,/Paracetamol/);
input('medicine-search','not found',{pickerLine:'0'});assert.match(node('#medicine-options').innerHTML,/No matching/);
await click({selectMedicine:'med-b',selectLine:'0'});
assert.equal(evaluate('billDraft.items[0].medicine_id'),'med-b');assert.equal(node('#modal').open,false);
assert.match(evaluate("medicineOptions('',1)"),/data-select-medicine="med-b"[^>]*disabled/);
assert.match(evaluate("medicineOptions('',1)"),/data-select-medicine="med-c"[^>]*disabled/);
assert.match(evaluate("medicineOptions('<script>',0)"),/No matching/);
console.log('PASS medicine search filters case-insensitively, handles no results and selects a bill medicine');

node('#medicine-name').value='';await evaluate('receipt()');
input('medicine-name','para');assert.match(node('#stock-matches').innerHTML,/Paracetamol 500 mg/);
assert.equal(node('#existing-stock-warning').innerHTML,'');
await click({stockMatch:'med-a'});assert.equal(node('#medicine-name').value,'Paracetamol 500 mg');assert.equal(node('#receipt-mrp').value,100);
assert.match(node('#existing-stock-warning').innerHTML,/already exists/);
node('#receipt-qty').value='2';node('#receipt-cost').value='100';node('#receipt-date').value='2026-01-01';
const form={id:'receipt-form',querySelector:()=>node('submit-receipt')};
const beforeReceipt=requests.filter(r=>r.path==='/api/receipts').length;
await handlers.submit({preventDefault(){},target:form});
assert.equal(requests.filter(r=>r.path==='/api/receipts').length,beforeReceipt,'Existing stock cannot post before confirmation');
assert.match(node('#receipt-error').innerHTML,/confirm/);
node('#confirm-existing').checked=true;
// No navigation is needed to verify the write contract.
evaluate('navigate=async()=>{}');
await handlers.submit({preventDefault(){},target:form});
const receipt=requests.filter(r=>r.path==='/api/receipts').at(-1);
assert.equal(JSON.parse(receipt.body).confirm_existing,true);
assert.equal(JSON.parse(receipt.body).name,'Paracetamol 500 mg');
input('medicine-name','Different medicine');assert.equal(node('#confirm-existing'),null,'Changing a name clears duplicate confirmation');
console.log('PASS visible stock matches, selection, duplicate warning and confirmed receipt payload');

// A new medicine may already have been saved when the response is lost.
input('medicine-name','Retry medicine');node('#receipt-mrp').value='10';
receiptStatus=503;
await assert.rejects(evaluate('saveReceipt()'),/Response interrupted/);
const originalReceipt=requests.at(-1);
assert.equal(JSON.parse(originalReceipt.body).confirm_existing,false);
medicines.push({id:'retry-med',name:'Retry medicine',quantity:2,mrp_paisa:1000});
evaluate(`meds=${JSON.stringify(medicines)};updateStockMatches()`);
receiptStatus=201;await evaluate('saveReceipt()');
assert.equal(requests.at(-1).body,originalReceipt.body);
assert.equal(requests.at(-1).headers['Idempotency-Key'],originalReceipt.headers['Idempotency-Key']);
console.log('PASS lost receipt response retries the original new-medicine intent even after it appears in stock');

const billHTML=await evaluate('newBill()');
assert.match(billHTML,/id="patient-contact"[^>]*type="tel"/);
assert.doesNotMatch(billHTML,/id="patient-contact"[^>]*required/);
assert.doesNotMatch(billHTML,/due-validation|Payment cannot exceed|id="amount-due"[^>]*max=/);
evaluate("patients=[{patient_name:'Patient One',contact_number:'0012345678'}]");
node('#patient-contact').value='';input('patient','Patient One');
assert.equal(node('#patient-contact').value,'0012345678');assert.equal(evaluate('billDraft.contact_number'),'0012345678');
input('patient','Another patient');assert.equal(node('#patient-contact').value,'');
input('patient-contact','9800000000');input('patient','Patient One');assert.equal(node('#patient-contact').value,'9800000000','Manually entered contact is preserved');
console.log('PASS optional contact field, saved patient contact suggestions and no MRP warning or amount cap');
evaluate('user={canManageInventory:true,canEditStock:true}');
assert.match(evaluate('stockTable(meds)'),/data-edit-stock=/);assert.match(evaluate('stockTable(meds)'),/data-delete-stock=/);
evaluate('user={canManageInventory:true,canEditStock:false}');assert.match(evaluate('stockTable(meds)'),/data-receive=/);assert.doesNotMatch(evaluate('stockTable(meds)'),/data-edit-stock=|data-delete-stock=/);
evaluate('user={canManageInventory:false,canEditStock:false}');assert.doesNotMatch(evaluate('stockTable(meds)'),/data-edit-stock=|data-delete-stock=/);
evaluate('user={canManageInventory:true,canEditStock:true}');
const reviewed=medicines[0],editForm={id:'stock-edit-form',dataset:{id:reviewed.id,reviewed:JSON.stringify(reviewed)}};
node('#edit-stock-name').value='Corrected medicine';node('#edit-stock-mrp').value='150';node('#edit-stock-quantity').value='25';
await evaluate('saveStockChange('+JSON.stringify(editForm)+')');
let change=requests.at(-1);assert.equal(change.method,'PATCH');assert.equal(change.path,'/api/medicines/med-a');
assert.deepEqual(JSON.parse(change.body),{expected_name:reviewed.name,expected_mrp_paisa:reviewed.mrp_paisa,expected_quantity:reviewed.quantity,name:'Corrected medicine',mrp_paisa:15000,quantity:25});
await evaluate('saveStockChange('+JSON.stringify({...editForm,id:'stock-delete-form'})+')');
change=requests.at(-1);assert.equal(change.method,'DELETE');assert.equal(JSON.parse(change.body).expected_quantity,reviewed.quantity);
evaluate('user={canManageInventory:true,canEditStock:false}');
await evaluate("receipt('med-a')");assert.equal(node('#receipt-mrp').readOnly,true,'Inventory admin cannot edit an existing MRP when adding stock');
const beforeDenied=requests.length;await assert.rejects(evaluate('saveStockChange('+JSON.stringify(editForm)+')'),/Only Pathak Bibek/);assert.equal(requests.length,beforeDenied);
console.log('PASS owner-only edit/delete controls, inventory-admin add-stock controls, and protected receipt MRP');
