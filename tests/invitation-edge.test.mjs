import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {webcrypto} from 'node:crypto';
const helper=readFileSync(new URL('../supabase/functions/_shared/password-credential.ts',import.meta.url),'utf8').replace(/^export /gm,'');
const source=helper+'\n'+readFileSync(new URL('../supabase/functions/accept-invitation/index.ts',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
function setup(inv={expires_at:new Date(Date.now()+60000).toISOString(),used_at:null,revoked_at:null},creationError=null,completionError=null){
 let handler,created,completed,deleted;
 const admin={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:inv})})})}),rpc:async(name,args)=>{completed={name,args};return {error:completionError};},auth:{admin:{createUser:async args=>{created=args;return {data:{user:{id:'created-user'}},error:creationError};},deleteUser:async id=>{deleted=id;return {error:null};}}}};
 vm.runInNewContext(code,{Deno:{env:{get:()=> 'server-only'},serve:fn=>{handler=fn;}},createClient:()=>admin,Response,Request,TextEncoder,crypto:webcrypto});
 return {send:body=>handler(new Request('https://test.invalid',{method:'POST',body:JSON.stringify(body)})),created:()=>created,completed:()=>completed,deleted:()=>deleted};
}
test('invitation endpoint creates a confirmed username account with protected invitation metadata',async()=>{
 const api=setup();const r=await api.send({token:'a'.repeat(64),username:'Test.User',password:'password123',role:'admin'});
 assert.equal(r.status,200);assert.equal(api.created().email,'test.user@users.pistache.invalid');assert.equal(api.created().email_confirm,true);
 assert.match(api.created().password,/^MUC1!Aa0[a-f0-9]{64}$/);
 assert.equal(api.created().app_metadata.role,undefined);assert.equal(api.created().app_metadata.invitation_hash.length,64);
 assert.equal(api.completed().name,'complete_account_invitation');assert.equal(api.completed().args.p_user_id,'created-user');
});
test('a three-character password creates an account and two characters keep the invitation usable',async()=>{
 const api=setup();
 const short=await api.send({token:'a'.repeat(64),username:'person',password:'ab'});
 assert.equal(short.status,400);assert.equal(api.created(),undefined);
 const valid=await api.send({token:'a'.repeat(64),username:'person',password:'abc'});
 assert.equal(valid.status,200);assert.match(api.created().password,/^MUC1!Aa0[a-f0-9]{64}$/);
});
test('a failed profile transaction removes the incomplete Auth user and preserves the invitation',async()=>{
 const api=setup(undefined,null,{code:'23505',message:'duplicate key value'});
 const response=await api.send({token:'a'.repeat(64),username:'person',password:'password123'});
 assert.equal(response.status,409);assert.equal(api.deleted(),'created-user');assert.match((await response.json()).error,/lien d.invitation reste valide/i);
});
test('used invitations and malformed credentials never create an account',async()=>{
 const used=setup({used_at:'today'});assert.equal((await used.send({token:'a'.repeat(64),username:'person',password:'password123'})).status,400);assert.equal(used.created(),undefined);
 const invalid=setup();assert.equal((await invalid.send({token:'bad',username:'person',password:'password123'})).status,400);assert.equal(invalid.created(),undefined);
});
test('creation errors explain that the invitation remains reusable',async()=>{
 const duplicate=setup(undefined,{code:'email_exists',message:'A user with this email has already been registered'});
 const duplicateResponse=await duplicate.send({token:'a'.repeat(64),username:'person',password:'password123'});
 assert.equal(duplicateResponse.status,409);assert.match((await duplicateResponse.json()).error,/lien d.invitation reste valide/i);
 const weak=setup(undefined,{code:'weak_password',message:'Password is too weak'});
 const weakResponse=await weak.send({token:'a'.repeat(64),username:'person',password:'password123'});
 assert.equal(weakResponse.status,400);assert.match((await weakResponse.json()).error,/mot de passe/i);
});
