import type { ActorState, GameEvent, Identity, MapProp, Snapshot } from '../shared/protocol';

interface Particle { x:number; y:number; vx:number; vy:number; life:number; color:string }
export class ArenaRenderer {
  readonly context: CanvasRenderingContext2D;
  width = innerWidth;
  height = innerHeight;
  zoom = 1;
  camera = { x:1500, y:1500 };
  private particles: Particle[] = [];
  constructor(readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d'); if (!context) throw new Error('이 브라우저에서 Canvas를 사용할 수 없습니다.'); this.context = context;
    this.resize(); window.addEventListener('resize', () => this.resize());
  }
  resize() {
    this.width = innerWidth; this.height = innerHeight;
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.canvas.width = Math.round(this.width*dpr); this.canvas.height = Math.round(this.height*dpr);
    this.canvas.style.width = this.width+'px'; this.canvas.style.height = this.height+'px';
    this.context.setTransform(dpr,0,0,dpr,0,0);
  }
  worldPointer(x:number,y:number) { return { x:(x-this.width/2)/this.zoom+this.camera.x, y:(y-this.height/2)/this.zoom+this.camera.y }; }
  event(event:GameEvent) {
    const colors:Record<string,string> = { land:'#675143',loot:'#ffdf32',hit:'#ff4545',shot:'#fff8aa',kill:'#e0674e',portal_spawn:'#40f78c' };
    const color = event.color || colors[event.type]; if (!color) return;
    const count = event.type === 'land' ? 18 : 8;
    for(let i=0;i<count;i++) this.particles.push({x:event.x,y:event.y,vx:(Math.random()-.5)*180,vy:(Math.random()-.5)*180,life:.35+Math.random()*.35,color});
    if (this.particles.length>400) this.particles.splice(0,this.particles.length-400);
  }
  clearParticles() { this.particles=[]; }
  draw(snapshot:Snapshot|null,map:MapProp[],roster:Identity[],myId:number,dt:number,focusId?:number) {
    const ctx=this.context,w=this.width,h=this.height;
    ctx.clearRect(0,0,w,h);ctx.fillStyle='#d4a373';ctx.fillRect(0,0,w,h);
    if(!snapshot) { this.drawIdle();return; }
    const me=snapshot.entities.find(e=>e.id===myId);
    const focus=snapshot.entities.find(e=>e.id===(focusId??myId))||me||snapshot.entities[0];
    if(!focus)return;
    this.camera={x:focus.x,y:focus.y};
    this.zoom=Math.max(.22,Math.min(1.15,Math.min(w/1280,h/720)*(1.05-focus.z/1350)));
    ctx.save();ctx.translate(w/2,h/2);ctx.scale(this.zoom,this.zoom);ctx.translate(-this.camera.x,-this.camera.y);
    this.drawGround();
    if(snapshot.phase==='GROUND'&&snapshot.safeZone.currentR>0){
      const z=snapshot.safeZone;ctx.save();ctx.beginPath();ctx.rect(-5000,-5000,13000,13000);ctx.arc(z.currentX,z.currentY,z.currentR,0,Math.PI*2,true);ctx.fillStyle='rgba(0,100,255,.19)';ctx.fill();ctx.beginPath();ctx.arc(z.currentX,z.currentY,z.currentR,0,Math.PI*2);ctx.strokeStyle='rgba(230,245,255,.9)';ctx.lineWidth=4;ctx.stroke();ctx.restore();
    }
    for(const crater of snapshot.craters){ctx.fillStyle=`rgba(0,0,0,${Math.max(0,Math.min(1,crater.alpha))*.4})`;ctx.beginPath();ctx.arc(crater.x,crater.y,crater.radius,0,Math.PI*2);ctx.fill();}
    for(const prop of map)this.drawProp(prop);
    if(snapshot.portal.active){const p=snapshot.portal;ctx.save();ctx.translate(p.x,p.y);ctx.rotate(performance.now()/500);ctx.beginPath();ctx.arc(0,0,p.radius,0,Math.PI*2);ctx.fillStyle='#00ff0040';ctx.fill();ctx.strokeStyle='#21ff5a';ctx.lineWidth=5;ctx.setLineDash([10,5]);ctx.stroke();ctx.restore();}
    for(const box of snapshot.loot){ctx.save();ctx.translate(box.x,box.y);ctx.fillStyle='#ffd52e';ctx.strokeStyle='#b18113';ctx.lineWidth=2;ctx.fillRect(-15,-15,30,30);ctx.strokeRect(-15,-15,30,30);ctx.fillStyle='#24200e';ctx.font='bold 23px Arial';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('?',0,1);ctx.restore();}
    const identities=new Map(roster.map(p=>[p.id,p]));
    for(const actor of [...snapshot.entities].sort((a,b)=>a.z-b.z))this.drawActor(actor,identities.get(actor.id),actor.id===myId);
    ctx.fillStyle='#ffeb3d';for(const bullet of snapshot.bullets){ctx.beginPath();ctx.arc(bullet.x,bullet.y,4,0,Math.PI*2);ctx.fill();}
    this.particles=this.particles.filter(p=>p.life>0);for(const p of this.particles){p.x+=p.vx*dt;p.y+=p.vy*dt;p.life-=dt;ctx.globalAlpha=Math.max(0,p.life);ctx.fillStyle=p.color;ctx.beginPath();ctx.arc(p.x,p.y,3,0,Math.PI*2);ctx.fill();}ctx.globalAlpha=1;
    ctx.restore();this.drawMinimap(snapshot,myId);
  }
  private drawIdle() {
    const ctx=this.context;ctx.save();ctx.globalAlpha=.12;
    const size=110;for(let y=0;y<this.height;y+=size)for(let x=0;x<this.width;x+=size)if((x/size+y/size)%2===0){ctx.fillStyle='#8b5b38';ctx.fillRect(x,y,size,size);}
    ctx.fillStyle='#533d32';for(let i=0;i<14;i++){ctx.beginPath();ctx.arc((i*317+80)%this.width,(i*173+60)%this.height,18+i%4*12,0,Math.PI*2);ctx.fill();}ctx.restore();
  }
  private drawGround() { const ctx=this.context;ctx.fillStyle='#c69a6b';ctx.fillRect(0,0,3000,3000);ctx.fillStyle='#d0a575';for(let y=0;y<3000;y+=160)for(let x=0;x<3000;x+=160)if((x/160+y/160)%2===0)ctx.fillRect(x,y,160,160);ctx.strokeStyle='#86634b';ctx.lineWidth=10;ctx.strokeRect(0,0,3000,3000); }
  private drawProp(p:MapProp) { const ctx=this.context;if(p.type==='BUILDING'){ctx.fillStyle='#4c3429';ctx.fillRect(p.x,p.y+12,p.width,p.height);ctx.fillStyle='#78503d';ctx.fillRect(p.x,p.y,p.width,p.height);ctx.fillStyle='#594033';ctx.fillRect(p.x+9,p.y+9,Math.max(0,p.width-18),Math.max(0,p.height-18));ctx.fillStyle='#352822';ctx.fillRect(p.x+17,p.y+17,Math.max(0,p.width-34),Math.max(0,p.height-34));}else{const r=p.width/2;ctx.fillStyle='#8b6848';ctx.beginPath();ctx.arc(p.x+7,p.y+8,r,0,Math.PI*2);ctx.fill();ctx.fillStyle='#795744';ctx.beginPath();ctx.arc(p.x,p.y,r,0,Math.PI*2);ctx.fill();ctx.fillStyle='#85614e';ctx.beginPath();ctx.arc(p.x-r*.2,p.y-r*.25,r*.43,0,Math.PI*2);ctx.fill();} }
  private drawActor(e:ActorState,identity:Identity|undefined,mine:boolean){
    const ctx=this.context;if(!e.alive){ctx.fillStyle='#654332';ctx.beginPath();ctx.arc(e.x,e.y,10,0,Math.PI*2);ctx.fill();return;}
    ctx.fillStyle='#0006';ctx.beginPath();ctx.arc(e.x,e.y,Math.max(2,15*(1-e.z/2000)),0,Math.PI*2);ctx.fill();
    const scale=1+e.z/800;ctx.save();ctx.translate(e.x,e.y);ctx.scale(scale,scale);ctx.rotate(e.angle);
    if(mine&&e.lootCount>=7){ctx.shadowBlur=20;ctx.shadowColor='#00ff60';}
    ctx.fillStyle=identity?.color||(e.bot?'#ff5960':'#00bfff');ctx.beginPath();ctx.arc(0,0,15,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
    if(mine){ctx.strokeStyle='#ffffff75';ctx.lineWidth=1;ctx.stroke();}ctx.fillStyle='#fff';
    if(e.weapon==='GUN')ctx.fillRect(10,-5,20,10);else if(e.weapon==='KNIFE'){ctx.beginPath();ctx.moveTo(10,0);ctx.lineTo(30,0);ctx.lineWidth=4;ctx.strokeStyle='#cfd8dc';ctx.stroke();}else if(e.weapon==='SHIELD'){ctx.strokeStyle='#5168e8';ctx.lineWidth=4;ctx.beginPath();ctx.arc(0,0,23,-Math.PI/2,Math.PI/2);ctx.stroke();}else{ctx.beginPath();ctx.arc(12,5,5,0,Math.PI*2);ctx.arc(12,-5,5,0,Math.PI*2);ctx.fill();}
    if(e.isDiving&&e.z>0){ctx.strokeStyle='#fff9';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(-15,-15);ctx.lineTo(-30,-30);ctx.moveTo(-15,15);ctx.lineTo(-30,30);ctx.stroke();}ctx.restore();
    ctx.font='bold 12px Arial';ctx.textAlign='center';ctx.fillStyle='#fff';ctx.lineWidth=3;ctx.strokeStyle='#0008';const label=(mine?'나 · ':'')+(identity?.nick||(e.bot?'BOT '+e.id:'PLAYER'));ctx.strokeText(label,e.x,e.y-31*scale);ctx.fillText(label,e.x,e.y-31*scale);ctx.fillStyle='#e04f40';ctx.fillRect(e.x-15,e.y-43*scale,30,4);ctx.fillStyle='#34e675';ctx.fillRect(e.x-15,e.y-43*scale,30*Math.max(0,e.hp/e.maxHp),4);
  }
  private drawMinimap(s:Snapshot,myId:number){const ctx=this.context,size=this.width<780?100:132,margin=this.width<780?12:18,scale=size/3000;ctx.save();ctx.translate(margin,margin);ctx.fillStyle='#211f1bc4';ctx.fillRect(0,0,size,size);ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.strokeRect(0,0,size,size);ctx.save();ctx.beginPath();ctx.rect(0,0,size,size);ctx.clip();if(s.phase==='GROUND'){ctx.strokeStyle='#6e9fff';ctx.lineWidth=1;ctx.beginPath();ctx.arc(s.safeZone.currentX*scale,s.safeZone.currentY*scale,s.safeZone.currentR*scale,0,Math.PI*2);ctx.stroke();}if(s.portal.active){ctx.fillStyle='#39ff68';ctx.beginPath();ctx.arc(s.portal.x*scale,s.portal.y*scale,4,0,Math.PI*2);ctx.fill();}for(const e of s.entities){if(!e.alive)continue;ctx.fillStyle=e.id===myId?'#17d9ff':e.bot?'#ff675e':'#fff';ctx.beginPath();ctx.arc(e.x*scale,e.y*scale,e.id===myId?3:1.8,0,Math.PI*2);ctx.fill();}ctx.restore();ctx.restore();}
}
