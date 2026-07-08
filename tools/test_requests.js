import http from 'http';

function request(options, body=null, cookies=null){
  return new Promise((resolve,reject)=>{
    if (cookies) options.headers = {...options.headers, Cookie: cookies.join('; ')};
    const req = http.request(options, res=>{
      let data='';
      res.on('data', d=> data += d.toString());
      res.on('end', ()=>{
        resolve({status: res.statusCode, headers: res.headers, body: data});
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

(async ()=>{
  try{
    console.log('GET /health');
    let r = await request({hostname:'127.0.0.1', port:3333, path:'/health', method:'GET', headers:{'Accept':'application/json'}});
    console.log(r.body);

    const usuario = {nome:'Tester', email:'test+iana@example.com', senha:'pass123'};
    const registroBody = JSON.stringify(usuario);
    console.log('\nPOST /auth/registro');
    r = await request({hostname:'127.0.0.1', port:3333, path:'/auth/registro', method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(registroBody)}}, registroBody);
    console.log('status', r.status, r.body);
    const setCookie = r.headers['set-cookie'] || [];
    console.log('set-cookie', setCookie);

    console.log('\nPOST /auth/login');
    const loginBody = JSON.stringify({email:usuario.email, senha:usuario.senha});
    r = await request({hostname:'127.0.0.1', port:3333, path:'/auth/login', method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(loginBody)}}, loginBody);
    console.log('status', r.status, r.body);

    console.log('\nPOST /chat/stream (visitor)');
    const msgBody = JSON.stringify({mensagem:'Olá Iana, teste local'});
    r = await request({hostname:'127.0.0.1', port:3333, path:'/chat/stream', method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(msgBody)}}, msgBody);
    console.log('status', r.status, r.body);

  }catch(e){
    console.error('ERROR', e);
  }
})();
