import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const source=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
function setup(token,acceptInvitation,login=async()=>({})) {
 const nodes=new Map();const get=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',hidden:false,disabled:false});return nodes.get(id);};
 const ctx=vm.createContext({document:{querySelector:get},acceptInvitation,login,beginCloud:async()=>{},sessionStorage:{removeItem(){}},guestModeKey:'guest',localMode:false});
 vm.runInContext('let invitationToken='+JSON.stringify(token)+';let registrationMode=false;'+source.slice(source.indexOf('function setRegistrationMode('),source.indexOf('document.querySelector("#syncButton").onclick')),ctx);
 vm.runInContext('setRegistrationMode()',ctx);
 get('#loginEmail').value='yassine';get('#loginPassword').value='password-123';
 return {get,submit:()=>get('#loginForm').onsubmit({preventDefault(){}})};
}
test('invitation signup uses username and password then offers login without email confirmation',async()=>{
 let args;const {get,submit}=setup('token',async(...a)=>{args=a;});await submit();
 assert.deepEqual(args,['token','yassine','password-123']);
 assert.equal(get('#loginPassword').value,'');assert.equal(get('#loginTitle').textContent,'Compte créé. Connectez-vous.');
 assert.equal(get('#loginSubmit').textContent,'Se connecter');
});
test('invalid invitation remains visible with a retryable error',async()=>{
 const {get,submit}=setup('token',async()=>{throw new Error('Invitation expirée');});await submit();
 assert.equal(get('#loginError').textContent,'Invitation expirée');assert.equal(get('#loginSubmit').disabled,false);
});
test('a short password is rejected locally without consuming the invitation',async()=>{
 let calls=0;const {get,submit}=setup('token',async()=>{calls++;});get('#loginPassword').value='court';await submit();
 assert.equal(calls,0);assert.match(get('#loginError').textContent,/8 caractères/);assert.equal(get('#loginSubmit').disabled,false);
});
test('normal login never calls account creation',async()=>{
 let signedIn=false;const {submit}=setup('',async()=>{throw new Error('Must not create');},async()=>{signedIn=true;return {};});await submit();assert.equal(signedIn,true);
});
test('guest mode cannot edit, persist, confirm or cancel existing drafts', async()=>{
  const context=vm.createContext({localMode:true,currentUser:{role:'viewer'},Promise});
  vm.runInContext(source.slice(source.indexOf('function canEditSelectedRoom()'),source.indexOf('function roomTypeId(')),context);
  assert.equal(vm.runInContext('canEditSelectedRoom()',context),false);
  vm.runInContext(source.slice(source.indexOf('function persistProject('),source.indexOf('let rooms =')),context);
  await vm.runInContext('persistProject("201:bedroom:paint")',context);
  const handlers={};context.document={querySelector:id=>handlers[id] ||= {}};
  vm.runInContext(source.slice(source.indexOf('document.querySelector("#confirmProgress").onclick'),source.indexOf('document.querySelector("#taskManagementList").addEventListener("submit"')),context);
  await handlers['#confirmProgress'].onclick();
  await handlers['#cancelProgress'].onclick();
});
test('Valider queues drafts locally without invoking synchronization',async()=>{
  let validated=0,sent=0;
  const nodes=new Map();const get=id=>{if(!nodes.has(id))nodes.set(id,{disabled:false,textContent:''});return nodes.get(id);};
  const context=vm.createContext({
    localMode:false,currentUser:{role:'admin'},saveQueue:Promise.resolve(),
    cloud:{snapshot:{projectId:'p'},engine:{operations:async()=>[{state:'draft'}]},confirmDrafts:async()=>{validated++;},project:async()=>({})},
    confirm:()=>true,document:{querySelector:get},state:{records:{}},currentFloorRecords:()=>({}),
    render:()=>{},renderSync:async()=>{},renderEditor:()=>{},syncCloud:()=>{sent++;},
  });
  vm.runInContext(source.slice(source.indexOf('document.querySelector("#confirmProgress").onclick'),source.indexOf('function filterTaskManagement()')),context);
  await get('#confirmProgress').onclick();
  assert.equal(validated,1);
  assert.equal(sent,0);
});
test('Excel export reads shared results without sending pending changes',async()=>{
  let refreshed=0,downloaded=0,sent=0;
  const nodes=new Map();const get=id=>{if(!nodes.has(id))nodes.set(id,{disabled:false,textContent:'Exporter Excel'});return nodes.get(id);};
  const context=vm.createContext({
    cloud:{snapshot:{tasks:[],taskTypes:[]}},currentUser:{role:'admin'},document:{querySelector:get},
    refreshCloudReadOnly:async()=>{refreshed++;return true;},
    syncCloud:async()=>{sent++;return true;},
    downloadProgressWorkbook:async()=>{downloaded++;},cloudErrorMessage:error=>error.message,
  });
  vm.runInContext(source.slice(source.indexOf('document.querySelector("#exportExcel").onclick'),source.indexOf('function reportPlanSvg(')),context);
  await get('#exportExcel').onclick({currentTarget:get('#exportExcel')});
  assert.equal(refreshed,1);
  assert.equal(downloaded,1);
  assert.equal(sent,0);
});
