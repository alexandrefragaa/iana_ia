import express from 'express';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readdirSync,readFileSync,existsSync} from 'node:fs';
import crypto from 'node:crypto';
import {VisionBridge} from './core/vision-bridge.js';

const root=path.dirname(fileURLToPath(import.meta.url));
const app=express();
const port=Number(process.env.IANA_VISION_PORT||3334);
const token=crypto.randomBytes(24).toString('hex');
const detector=new VisionBridge(root);
app.use((req,res,next)=>{
  const host=req.hostname;
  if(!['localhost','127.0.0.1','::1'].includes(host))return res.status(403).json({error:'Acesso somente local.'});
  res.set('Cache-Control','no-store');
  if(req.method==='POST' && req.get('X-Iana-Vision')!==token)return res.status(403).json({error:'Sessão local inválida.'});
  next();
});
app.use(express.json({limit:'3mb'}));
app.use(express.static(path.join(root,'public','vision')));
app.get('/api/status',(req,res)=>res.json({...detector.state,token}));
app.post('/api/start',(req,res)=>{detector.start();res.json({ok:true});});
app.post('/api/stop',(req,res)=>{detector.close();res.json({ok:true});});
app.post('/api/frame',async(req,res)=>{
  try{
    const image=req.body?.image;
    if(typeof image!=='string'||image.length>2_800_000||!image.match(/^[A-Za-z0-9+/=]+$/))return res.status(400).json({error:'Quadro inválido.'});
    res.json(await detector.infer(image));
  }catch(error){res.status(error.status||503).json({error:error.message});}
});
app.get('/api/games',(req,res)=>{
  const steam=process.env.STEAM_PATH||'C:/Program Files (x86)/Steam';
  const libraries=new Set([steam]);
  try{const vdf=readFileSync(path.join(steam,'steamapps','libraryfolders.vdf'),'utf8');for(const m of vdf.matchAll(/"path"\s+"([^"\n]+)"/g))libraries.add(m[1].replace(/\\\\/g,'\\'));}catch{}
  const games=[];
  for(const lib of libraries){
    const folder=path.join(lib,'steamapps');if(!existsSync(folder))continue;
    for(const file of readdirSync(folder).filter(f=>/^appmanifest_\d+\.acf$/.test(f))){
      try{const content=readFileSync(path.join(folder,file),'utf8');const name=/"name"\s+"([^"]+)"/.exec(content)?.[1];const appId=/"appid"\s+"(\d+)"/.exec(content)?.[1];if(name&&appId)games.push({name,appId});}catch{}
    }
  }
  const unique=[...new Map(games.filter(g=>g.appId!=='228980').map(g=>[g.appId,g])).values()];
  res.json({games:unique.sort((a,b)=>a.name.localeCompare(b.name)),offlineSupportVerified:false});
});
app.use((err,req,res,next)=>res.status(err.status||500).json({error:err.status===413?'Quadro muito grande.':'Falha no serviço de visão.'}));
const server=app.listen(port,'127.0.0.1',()=>console.log(`Visão local: http://localhost:${port}`));
function stop(){detector.close();server.close(()=>process.exit(0));}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
