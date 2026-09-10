import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';

export function isPublicIP(ip) {
  if (net.isIP(ip) === 6) {
    // Accept global unicast only; deny mapped IPv4 and transition ranges.
    const value = ip.toLowerCase();
    return /^[23]/.test(value) && !value.startsWith('2001:') && !value.startsWith('2002:');
  }
  if (net.isIP(ip) !== 4) return false;
  const [a,b] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0,168].includes(b)) ||
    (a === 198 && [18,19,51].includes(b)) || (a === 203 && b === 0));
}

export async function readPublicHTML(url, redirects = 0) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || redirects > 3) throw new Error('URL não permitida.');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const records = net.isIP(host) ? [{address:host,family:net.isIP(host)}] : await dns.lookup(host,{all:true});
  if (!records.length || records.some(r=>!isPublicIP(r.address))) throw new Error('Endereço de rede não público.');
  const pinned = records[0];
  return new Promise((resolve,reject)=>{
    const request = (parsed.protocol === 'https:' ? https : http).get(parsed, {
      agent:false,
      lookup: (_hostname,options,cb)=> options?.all ? cb(null,[pinned]) : cb(null,pinned.address,pinned.family),
      headers:{'User-Agent':'IanaBot/1.0','Accept':'text/html'}
    },res=>{
      if ([301,302,303,307,308].includes(res.statusCode)) {
        res.resume(); clearTimeout(timer);
        if (!res.headers.location) return reject(new Error('Redirecionamento inválido.'));
        readPublicHTML(new URL(res.headers.location,parsed).href,redirects+1).then(resolve,reject);
        return;
      }
      if (res.statusCode !== 200 || !String(res.headers['content-type']).includes('text/html')) {res.resume();clearTimeout(timer);resolve(null);return;}
      let size=0; const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>1500000)request.destroy(new Error('Página muito grande.'));else chunks.push(chunk);});
      res.on('end',()=>{clearTimeout(timer);resolve(Buffer.concat(chunks).toString('utf8'));});
      res.on('error',reject);
    });
    const timer=setTimeout(()=>request.destroy(new Error('Timeout ao ler página.')),8000);
    request.on('error',err=>{clearTimeout(timer);reject(err);});
  });
}
