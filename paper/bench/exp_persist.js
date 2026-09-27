const L=require('./linkcore.js');const fs=require('fs');const path=require('path');const {performance}=require('perf_hooks');
const {loadCert,summarize}=require('./common');console.error=()=>{};
const c=loadCert(2);const out={};
for(const base of ['/tmp','/dev/shm']){const d=fs.mkdtempSync(path.join(base,'persist-'));const ts=new L.TrustStore(d);
for(let i=0;i<7;i++)ts.pair({deviceId:'seed'+i+'0'.repeat(28),deviceName:'s',certPem:c.cert,protocolVersion:1,pairedAt:0});
const s=[];for(let k=0;k<60;k++){const id='x'+k+'0'.repeat(30);let t=performance.now();ts.pair({deviceId:id,deviceName:'n',certPem:c.cert,protocolVersion:1,pairedAt:0});s.push(performance.now()-t);t=performance.now();ts.unpair(id);s.push(performance.now()-t);}
out[base]=summarize(s);fs.rmSync(d,{recursive:true,force:true});process.stdout.write(`${base}: p50 ${out[base].p50.toFixed(3)} ms p95 ${out[base].p95.toFixed(3)} ms\n`);}
fs.writeFileSync('results/persist.json',JSON.stringify(out,null,2));
