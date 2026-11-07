import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const base = process.argv[2] || 'http://127.0.0.1:5173/';
const api = process.argv[3] || 'http://127.0.0.1:8787';
const output = process.argv[4] || '/tmp/ppi-io-online-soak';
mkdirSync(output, {recursive:true});
const browser = await chromium.launch({headless:true});
const page = await browser.newPage();
const errors=[], expectedHttpErrors=[];
page.on('pageerror',e=>errors.push(String(e)));
page.on('console',m=>{if(m.type()==='error'){
  if(m.text().includes('503')&&m.location().url.includes('/api/join'))expectedHttpErrors.push(m.text());
  else errors.push(m.text());
}});
try {
  await page.goto(base,{waitUntil:'networkidle'});
  const report = await page.evaluate(async ({api})=>{
    const startedAt=Date.now(), samples=[],rounds=[],problems=[];
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    let completed=0;
    while(Date.now()-startedAt<70000){
      const peers=[];
      for(let i=0;i<20;i++){
        const response=await fetch(api+'/api/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({protocol:1,build:'0.1.0',nick:'LOAD '+i,color:'#00BFFF',challengeToken:'',requestId:crypto.randomUUID()})});
        if(!response.ok)throw new Error('join '+i+' HTTP '+response.status+' '+await response.text());
        const join=await response.json();
        const peer={i,join,ws:null,seq:0,welcome:null,states:0,last:null,closed:false,closing:false,reason:'',types:[]};peers.push(peer);
        await new Promise((resolve,reject)=>{
          const ws=new WebSocket(join.wsUrl);peer.ws=ws;
          const timer=setTimeout(()=>reject(new Error('welcome timeout '+i)),5000);
          ws.onmessage=event=>{const m=JSON.parse(event.data);peer.types.push(m.type);if(m.type==='welcome'){peer.welcome=m;clearTimeout(timer);resolve();}if(m.type==='start'||m.type==='state'){peer.states++;peer.last=m;}if(m.type==='closed'){peer.reason=m.reason;}if(m.type==='match_result')completed++;};
          ws.onerror=()=>{clearTimeout(timer);reject(new Error('socket error '+i));};
          ws.onclose=event=>{peer.closed=true;if(event.code!==1000&&!peer.closing)problems.push({i,code:event.code,reason:event.reason,received:peer.reason});};
        });
      }
      const extra=await fetch(api+'/api/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({protocol:1,build:'0.1.0',nick:'EXTRA',color:'#00BFFF',challengeToken:'',requestId:crypto.randomUUID()})});
      if(extra.ok)throw new Error('21st player admitted');
      if((await extra.json()).reason!=='rooms_full')throw new Error('Unexpected 21st admission error');
      const roomIds=new Set(peers.map(p=>p.join.matchId));
      if(roomIds.size!==2)throw new Error('Expected exactly two rooms');
      const interval=setInterval(()=>{
        for(const p of peers)if(p.ws.readyState===WebSocket.OPEN)p.ws.send(JSON.stringify({type:'input',seq:p.seq++,dx:Math.sin(Date.now()/7000+p.i),dy:Math.cos(Date.now()/7000+p.i),aim:(p.i%10)*.6-3,attack:true,firePressed:p.seq%5===0,sprint:p.seq%20<5}));
      },100);
      const roundStart=Date.now();
      while(Date.now()-startedAt<70000 && peers.some(p=>!p.closed)){
        await sleep(5000);
        const sample={elapsed:Date.now()-startedAt,open:peers.filter(p=>!p.closed).length,states:peers.reduce((n,p)=>n+p.states,0),ticks:peers.map(p=>p.last?.snapshot?.t||0),reasons:[...new Set(peers.map(p=>p.reason).filter(Boolean))]};
        samples.push(sample);
        if(problems.length)break;
      }
      clearInterval(interval);
      rounds.push({duration:Date.now()-roundStart,rooms:[...roomIds],states:peers.map(p=>p.states),messages:peers.reduce((n,p)=>n+p.seq,0),lastPhases:peers.map(p=>p.last?.snapshot?.p),reasons:peers.map(p=>p.reason)});
      for(const p of peers){p.closing=true;p.ws.close(1000,'qa_complete');}
      if(problems.length)break;
      if(Date.now()-startedAt<70000)await sleep(5500);
    }
    return {elapsed:Date.now()-startedAt,rounds,samples,completed,problems};
  },{api});
  writeFileSync(output+'/results.json',JSON.stringify({base,api,errors,expectedHttpErrors,...report},null,2));
  if(errors.length||report.problems.length||expectedHttpErrors.length>report.rounds.length)throw new Error(JSON.stringify({errors,problems:report.problems}));
  if(report.elapsed<60000||!report.rounds.every(r=>r.states.every(n=>n>5)))throw new Error('Insufficient live state coverage');
  console.log('20-CLIENT SOAK OK',JSON.stringify({elapsed:report.elapsed,rounds:report.rounds.length,completed:report.completed,states:report.samples.at(-1)?.states}));
}finally{await browser.close();}
