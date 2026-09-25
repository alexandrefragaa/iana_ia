import {readFileSync,existsSync} from 'node:fs';
import {VisionBridge} from '../core/vision-bridge.js';
import {setTimeout as sleep} from 'node:timers/promises';
const bridge=new VisionBridge('C:/ia_platina');
try{
 bridge.start();
 for(let i=0;i<90&&!bridge.state.ready;i++){if(bridge.state.error)throw Error(bridge.state.error);await sleep(1000);}
 if(!bridge.state.ready)throw Error('Detector did not become ready');
 console.log('READY',JSON.stringify(bridge.state));
 const asset='C:/ia_platina/.venv/Lib/site-packages/ultralytics/assets/bus.jpg';
 if(!existsSync(asset))throw Error('Bundled test image absent');
 const image=readFileSync(asset).toString('base64');
 const ms=[];
 for(let i=0;i<6;i++){const t=performance.now();const r=await bridge.infer(image);ms.push(Math.round(performance.now()-t));console.log(JSON.stringify({test:i,latencyMs:ms.at(-1),inferenceMs:r.inferenceMs,labels:r.detections.map(d=>d.label)}));}
 console.log('MEAN_MS',Math.round(ms.slice(1).reduce((a,b)=>a+b,0)/5));
}catch(e){console.error(e.message);process.exitCode=1;}finally{bridge.close();}
