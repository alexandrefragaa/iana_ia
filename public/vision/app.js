'use strict';
const $=id=>document.getElementById(id);
let token='',stream=null,running=false,poll=null,aborter=null;
const video=$('video'),overlay=$('overlay'),frame=document.createElement('canvas');
async function api(url,body){const r=await fetch(url,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-Iana-Vision':token}:{},body:body?JSON.stringify(body):undefined,signal:aborter?.signal});const data=await r.json();if(!r.ok)throw Error(data.error);return data;}
async function status(){const s=await api('/api/status');token=s.token;$('start').disabled=!s.ready||running;$('device').textContent=`Dispositivo: ${s.device==='cpu'?'CPU':s.device?'GPU '+s.device:'—'}`;$('status').textContent=s.ready?'Detector pronto. Escolha a janela do jogo.':s.error|| (s.loading?'Carregando o modelo local…':'Detector ainda não iniciado.');return s;}
$('prepare').onclick=async()=>{try{await status();await api('/api/start',{});clearInterval(poll);poll=setInterval(async()=>{try{const s=await status();if(s.ready||s.error){clearInterval(poll);poll=null;}}catch(e){clearInterval(poll);$('status').textContent=e.message;}},1000);}catch(e){$('status').textContent=e.message;}};
function stop(){running=false;aborter?.abort();aborter=null;stream?.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;overlay.getContext('2d').clearRect(0,0,overlay.width,overlay.height);$('empty').hidden=false;$('stop').disabled=true;$('start').disabled=false;$('status').textContent='Captura parada.';}
$('stop').onclick=stop;
$('start').onclick=async()=>{try{stream=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:10},audio:false});video.srcObject=stream;await video.play();stream.getVideoTracks()[0].addEventListener('ended',stop,{once:true});running=true;aborter=new AbortController();$('empty').hidden=true;$('start').disabled=true;$('stop').disabled=false;loop();}catch(e){stop();$('status').textContent=e.name==='NotAllowedError'?'Compartilhamento cancelado.':e.message;}};
async function loop(){
 while(running){
  const t=performance.now();
  try{
   const scale=Math.min(1,960/video.videoWidth);frame.width=Math.round(video.videoWidth*scale);frame.height=Math.round(video.videoHeight*scale);
   if(!frame.width||!frame.height)break;
   frame.getContext('2d').drawImage(video,0,0,frame.width,frame.height);
   const result=await api('/api/frame',{image:frame.toDataURL('image/jpeg',.7).split(',')[1]});
   if(!running)break;
   const elapsed=performance.now()-t;overlay.width=result.width;overlay.height=result.height;const ctx=overlay.getContext('2d');ctx.strokeStyle='#83f0b8';ctx.fillStyle='#83f0b8';ctx.lineWidth=2;ctx.font='15px sans-serif';
   for(const d of result.detections){const [x1,y1,x2,y2]=d.xyxy;ctx.strokeRect(x1,y1,x2-x1,y2-y1);ctx.fillText(`${d.label} ${Math.round(d.confidence*100)}%`,x1,Math.max(16,y1-5));}
   $('latency').textContent=`Atraso: ${Math.round(elapsed)} ms · detector ${result.inferenceMs} ms`;$('count').textContent=`Objetos: ${result.detections.length}`;$('status').textContent='Análise local ativa. Progresso e rotas ainda exigem confirmação.';
  }catch(e){if(running){stop();$('status').textContent=e.message;}break;}
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,250-(performance.now()-t))));
 }
}
function key(){return 'iana-goals-'+($('game').value||$('manual-game').value.trim()||'session');}
function getGoals(){try{return JSON.parse(localStorage.getItem(key()))||[];}catch{return [];}}
function render(){const ul=$('goals');ul.replaceChildren();for(const [i,g] of getGoals().entries()){const li=document.createElement('li'),box=document.createElement('input');box.type='checkbox';box.checked=g.done;box.onchange=()=>{const goals=getGoals();goals[i].done=box.checked;localStorage.setItem(key(),JSON.stringify(goals));};li.append(box,document.createTextNode(g.text));ul.append(li);}}
$('goal-form').onsubmit=e=>{e.preventDefault();const goals=getGoals();goals.push({text:$('goal').value.trim(),done:false});localStorage.setItem(key(),JSON.stringify(goals));$('goal').value='';render();};$('game').onchange=render;$('manual-game').onchange=render;
window.addEventListener('beforeunload',()=>{running=false;stream?.getTracks().forEach(t=>t.stop());});
api('/api/games').then(({games})=>{for(const g of games){const o=document.createElement('option');o.value=g.appId;o.textContent=g.name;$('game').append(o);}}).catch(()=>{});status().catch(e=>$('status').textContent=e.message);render();
