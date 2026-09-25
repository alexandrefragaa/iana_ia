import test from 'node:test';
import assert from 'node:assert/strict';
import {VisionBridge} from '../core/vision-bridge.js';

test('detector rejects frames before readiness',async()=>{
 const bridge=new VisionBridge('.');
 await assert.rejects(bridge.infer('YWJj'),{status:503});
});
test('detector never queues overlapping frames',async()=>{
 const bridge=new VisionBridge('.');bridge.state.ready=true;bridge.pending={};
 await assert.rejects(bridge.infer('YWJj'),{status:429});
});
test('detector shutdown rejects an in-flight frame and clears state',async()=>{
 const bridge=new VisionBridge('.');let killed=false;bridge.worker={kill(){killed=true;}};bridge.state.ready=true;
 const failed=new Promise(resolve=>bridge.pending={reject:resolve,timer:setTimeout(()=>{},1000)});
 bridge.close();assert.equal((await failed).message,'Detector parado.');assert.equal(killed,true);assert.equal(bridge.pending,null);assert.equal(bridge.state.ready,false);
});
