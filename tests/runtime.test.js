import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureConversation, attachmentPart, escapeHTML, pythonExecutable} from '../core/runtime.js';
import {isPublicIP} from '../core/safe-links.js';

test('visitor cannot select a persistent conversation',async()=>{
 assert.equal(await ensureConversation({query(){throw Error('must not access DB');}},null,'other','hi'),null);
});
test('foreign conversation fails before any write',async()=>{
 let calls=0;
 const pool={async query(sql,args){calls++;assert.match(sql,/usuario_id=\?/);assert.deepEqual(args,['foreign',7]);return [[]];}};
 await assert.rejects(ensureConversation(pool,7,'foreign','hi'),{status:404});assert.equal(calls,1);
});
test('owned conversation can be used',async()=>{
 assert.equal(await ensureConversation({async query(){return [[{id:'mine'}]];}},7,'mine','hi'),'mine');
});
test('new conversations receive independent unpredictable ids',async()=>{
 const pool={async query(sql,args){assert.match(sql,/INSERT/);assert.equal(args[1],7);assert.ok(args[2].length<=80);return [{}];}};
 const a=await ensureConversation(pool,7,null,'x'.repeat(100)); const b=await ensureConversation(pool,7,null,'hi');assert.notEqual(a,b);
});
test('attachment validation rejects URLs, wrong types and oversized payloads',()=>{
 assert.equal(attachmentPart({}),null);
 for(const imagem of ['http://localhost/test','data:text/html;base64,PHNjcmlwdD4=',42])assert.throws(()=>attachmentPart({imagem}),{status:400});
 assert.throws(()=>attachmentPart({imagem:'data:image/png;base64,'+'A'.repeat(15*1024*1024)}),{status:413});
 assert.deepEqual(attachmentPart({imagem:'data:image/png;base64,YWJj'}),{inlineData:{mimeType:'image/png',data:'YWJj'}});
});
test('private and mapped addresses cannot be fetched',()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.0.1','100.64.0.1','::1','::ffff:127.0.0.1','::ffff:7f00:1','fc00::1','fe80::1','0.0.0.0'])assert.equal(isPublicIP(ip),false,ip);
 assert.equal(isPublicIP('8.8.8.8'),true);assert.equal(isPublicIP('2606:4700:4700::1111'),true);
});
test('feedback escapes markup',()=>{assert.equal(escapeHTML('<img onerror="x">'), '&lt;img onerror=&quot;x&quot;&gt;');});
test('explicit interpreter path is retained',()=>{assert.equal(pythonExecutable('.', {IANA_PYTHON_PATH:'custom'}),'custom');});
