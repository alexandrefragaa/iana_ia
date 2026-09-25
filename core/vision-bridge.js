import {spawn} from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import {pythonExecutable} from './runtime.js';

export class VisionBridge {
  constructor(root) { this.root=root;this.worker=null;this.pending=null;this.counter=0;this.state={ready:false,loading:false,error:null}; }
  start() {
    if(this.worker) return;
    this.state={ready:false,loading:true,error:null};
    const worker=spawn(pythonExecutable(this.root),[path.join(this.root,'core','vision_worker.py')],{cwd:this.root,stdio:['pipe','pipe','pipe'],windowsHide:true});
    this.worker=worker;
    this.startTimer=setTimeout(()=>this.fail('Inicialização do detector excedeu 90 segundos.'),90000);
    const lines=readline.createInterface({input:worker.stdout});
    lines.on('line',line=>{
      let data;try{data=JSON.parse(line);}catch{return;}
      if(data.event==='ready'){clearTimeout(this.startTimer);this.state={...data,ready:true,loading:false,error:null};return;}
      if(data.event==='error'){this.fail(data.error);return;}
      if(this.pending && data.id===this.pending.id){const task=this.pending;this.pending=null;clearTimeout(task.timer);data.error?task.reject(new Error(data.error)):task.resolve(data);}
    });
    worker.stderr.on('data',()=>{});
    worker.on('error',error=>this.fail(error.message));
    worker.on('exit',()=>{if(this.worker===worker){this.worker=null;this.fail('Detector encerrado. Reinicie a visão.');}});
  }
  fail(message) {
    clearTimeout(this.startTimer);
    this.state={ready:false,loading:false,error:message};
    const worker=this.worker;this.worker=null;worker?.kill();
    if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(new Error(message));this.pending=null;}
  }
  infer(image) {
    if(!this.state.ready) return Promise.reject(Object.assign(new Error(this.state.error||'Detector inicializando.'),{status:503}));
    if(this.pending) return Promise.reject(Object.assign(new Error('Detector ocupado; descarte este quadro.'),{status:429}));
    return new Promise((resolve,reject)=>{
      const id=++this.counter;
      this.pending={id,resolve,reject,timer:setTimeout(()=>this.fail('Tempo limite da análise excedido.'),15000)};
      this.worker.stdin.write(JSON.stringify({id,image})+'\n');
    });
  }
  close(){this.fail('Detector parado.');}
}
