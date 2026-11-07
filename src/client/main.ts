import './style.css';
import { GameSim, CONSTANTS, WEAPONS, predictMovement } from '../shared/simulation';
import { FIXED_STEP, unpackSnapshot, type ActorState, type GameEvent, type GameInput, type Identity, type InputFrame, type MapProp, type MatchResult, type Outcome, type ServerMessage, type Snapshot } from '../shared/protocol';
import { GameAudio } from './audio';
import { ArenaRenderer } from './renderer';
import { OnlineSession, friendlyNetworkReason, readOnlineConfig, type OnlineConfig } from './network';
import { SKINS, TrainingStore } from './storage';

const el = <T extends HTMLElement = HTMLElement>(id:string) => { const found=document.getElementById(id);if(!found)throw new Error('Missing UI '+id);return found as T; };
const show=(id:string,visible:boolean)=>{el(id).hidden=!visible;};
const text=(id:string,value:string)=>{if(el(id).textContent!==value)el(id).textContent=value;};
const audio=new GameAudio(),store=new TrainingStore(),renderer=new ArenaRenderer(el<HTMLCanvasElement>('gameCanvas')),network=new OnlineSession();
type Mode='menu'|'joining'|'lobby'|'practice'|'online'|'spectator'|'result';
let mode:Mode='menu',lastMode:'practice'|'online'='practice';
let config:OnlineConfig={apiUrl:'',turnstileSiteKey:''};
let simulation:GameSim|null=null,snapshot:Snapshot|null=null,previousSnapshot:Snapshot|null=null,map:MapProp[]=[],roster:Identity[]=[],myId=1;
let accumulator=0,lastFrame=performance.now(),lastSnapshotAt=0,lastInputAt=0,lastIdleAt=0,seq=0,lobbyEndsAt=0,matchId='',generation=0,resultPresented=false,matchEnded=false,toastTimer=0,neutralTimer=0,trainingOpen=false,joinAttempt=0,practiceGroundStarted=false;
let predicted:ActorState|null=null,predictionOffset={x:0,y:0};
let history:{frame:InputFrame;at:number}[]=[];
const keys=new Set<string>();let mouse={x:innerWidth/2,y:innerHeight/2,held:false,firePressed:false};
const seenEvents=new Set<number>();let lastInputSignature='';let practiceMatch=0;

function toast(message:string){text('toast',message);show('toast',true);clearTimeout(toastTimer);toastTimer=window.setTimeout(()=>show('toast',false),4500);}
function refreshTraining(){
  const save=store.save;text('gold-bar',`STAGE ${save.stage} · ${save.gold.toLocaleString()} G`);text('lab-gold',`${save.gold.toLocaleString()} G`);text('lab-stage',`STAGE ${save.stage}`);
  text('lab-stats',`연습 ${save.runs}판 · 포탈 ${save.portalWins} · 최후 생존 ${save.lastStandWins} · 누적 ${save.lifetimeGold.toLocaleString()} G`);
  text('online-records',`온라인 ${save.online.played}판 · 승리 ${save.online.wins} · ${save.online.kills}킬`);
  const upgrades=el('lab-upgrades');upgrades.replaceChildren();
  ['HP','ATK','SPD','STA','LUCK','IDLE','GEAR'].forEach((name,index)=>{
    const row=document.createElement('div');row.className='upg-row';const info=document.createElement('div'),label=document.createElement('b'),desc=document.createElement('small');
    label.textContent=`${name} Lv.${save.levels[index]}/${index===6?3:25}`;desc.textContent=store.description(index);info.appendChild(label);info.appendChild(document.createElement('br'));info.appendChild(desc);
    const button=document.createElement('button');button.type='button';button.dataset.upgrade=String(index);const max=save.levels[index]>=(index===6?3:25);button.textContent=max?'MAX':`${store.cost(index)} G`;button.disabled=max||save.gold<store.cost(index);
    button.onclick=()=>{if(mode!=='menu'&&mode!=='result')return;if(store.buy(index)){audio.init();audio.tone();refreshTraining();}};row.appendChild(info);row.appendChild(button);upgrades.appendChild(row);
  });
  const skins=el('lab-skins');skins.replaceChildren();for(const skin of SKINS){const button=document.createElement('button');button.type='button';button.textContent=save.stage>=skin.stage?skin.name:`S${skin.stage}`;button.disabled=save.stage<skin.stage;button.classList.toggle('selected',save.skinId===skin.id);button.style.borderBottomColor=skin.color;button.onclick=()=>{store.selectSkin(skin.id);refreshTraining();};skins.appendChild(button);}
}
function setTraining(open:boolean){trainingOpen=open;show('lab-panel',open);el('training-toggle').setAttribute('aria-expanded',String(open));text('training-toggle',open?'훈련소 닫기':'훈련소 열기');}
function setMode(next:Mode){
  mode=next;show('center-panel',next==='menu'||next==='joining');show('lobby-panel',next==='lobby');show('result-panel',next==='result');
  const active=['practice','online','spectator','result'].includes(next)&&!!snapshot;show('game-hud',active);document.body.classList.toggle('in-match',active);
  el<HTMLButtonElement>('online-btn').disabled=next==='joining'||!config.apiUrl;el<HTMLButtonElement>('start-btn').disabled=next==='joining';
  show('join-cancel-btn',next==='joining');if(next!=='menu'&&next!=='result')setTraining(false);
  show('spectator-banner',next==='spectator');
}
function neutralInput(){keys.clear();mouse.held=false;mouse.firePressed=false;lastInputSignature='';clearTimeout(neutralTimer);if(network.connected&&lastMode==='online'){sendInput(true);neutralTimer=window.setTimeout(()=>{if(document.hidden||!document.hasFocus())sendInput(true);},Math.max(1,101-(performance.now()-lastInputAt)));}}
function closeMatch(){joinAttempt++;neutralInput();clearTimeout(neutralTimer);network.close();audio.stopWind();simulation=null;predicted=null;history=[];seq=0;lastInputAt=0;lastIdleAt=0;previousSnapshot=null;renderer.clearParticles();}
function menu(message?:string){closeMatch();snapshot=null;map=[];roster=[];matchEnded=false;resultPresented=false;setMode('menu');refreshTraining();if(message)text('online-status',message);}
function nickname(){const name=el<HTMLInputElement>('nick-input').value.replace(/[\u0000-\u001f]/g,'').trim().slice(0,12)||'PLAYER';store.save.nick=name;store.persist();return name;}
function startPractice(){
  closeMatch();audio.init();audio.startWind();myId=1;lastMode='practice';matchId=`practice-${++practiceMatch}`;generation=0;resultPresented=false;matchEnded=false;practiceGroundStarted=false;seenEvents.clear();
  const seed=crypto.getRandomValues(new Uint32Array(1))[0];
  simulation=new GameSim({seed,humans:[{id:myId,nick:nickname(),color:store.skin().color,loadout:{levels:[...store.save.levels],stage:store.save.stage}}],bots:9,stage:store.save.stage,practice:true});
  map=simulation.mapSnapshot();roster=simulation.entities.map(e=>({id:e.id,nick:e.nick,color:e.color,bot:e.bot}));snapshot=simulation.snapshot();previousSnapshot=null;accumulator=0;lastFrame=performance.now();
  text('connection-state','');setMode('practice');updateHud();
}
async function joinOnline(){
  closeMatch();const attempt=joinAttempt;lastMode='online';snapshot=null;resultPresented=false;matchEnded=false;seenEvents.clear();audio.init();setMode('joining');
  try{await network.join(config,nickname(),store.skin().color,el('challenge-container'));}
  catch(error){if(attempt!==joinAttempt)return;network.close();setMode('menu');const message=error instanceof Error?error.message:'대전에 접속하지 못했습니다.';text('online-status',message);}
}
function readInput(consumeFire=false):GameInput{
  const dx=Number(keys.has('KeyD')||keys.has('ArrowRight'))-Number(keys.has('KeyA')||keys.has('ArrowLeft'));
  const dy=Number(keys.has('KeyS')||keys.has('ArrowDown'))-Number(keys.has('KeyW')||keys.has('ArrowUp'));
  const own=predicted||snapshot?.entities.find(e=>e.id===myId),world=renderer.worldPointer(mouse.x,mouse.y);
  const input:GameInput={dx,dy,aim:own?Math.atan2(world.y-own.y,world.x-own.x):0,attack:mouse.held,firePressed:mouse.firePressed,sprint:keys.has('ShiftLeft')||keys.has('ShiftRight')};
  if(consumeFire)mouse.firePressed=false;
  return input;
}
function sendInput(force=false){
  if(!network.connected||!['online','spectator','result'].includes(mode))return;
  const now=performance.now();if(now-lastInputAt<100)return;
  const input=mode==='online'?readInput():{dx:0,dy:0,aim:0,attack:false,firePressed:false,sprint:false};
  const signature=JSON.stringify(input),active=input.dx!==0||input.dy!==0||input.attack||input.firePressed||input.sprint;
  if(!force&&!active&&signature===lastInputSignature&&now-lastIdleAt<1000)return;
  const frame:InputFrame={type:'input',seq:++seq,...input};
  if(network.send(frame)){lastInputAt=now;lastIdleAt=now;lastInputSignature=signature;mouse.firePressed=false;history.push({frame,at:now});if(history.length>30)history.shift();}
}
function acceptSnapshot(next:Snapshot,ack:number){
  if(snapshot&&next.tick<snapshot.tick)return;
  const now=performance.now(),oldPredicted=predicted;previousSnapshot=snapshot;snapshot=next;lastSnapshotAt=now;
  history=history.filter(entry=>entry.frame.seq>ack);const own=next.entities.find(e=>e.id===myId);
  if(own){predicted={...own};for(let i=0;i<history.length;i++){const entry=history[i],end=history[i+1]?.at??now,dt=Math.min(.15,Math.max(0,(end-entry.at)/1000));Object.assign(predicted,predictMovement(predicted,entry.frame,map,dt));}if(oldPredicted&&own.alive){const x=oldPredicted.x-predicted.x,y=oldPredicted.y-predicted.y;predictionOffset=Math.hypot(x,y)<100?{x,y}:{x:0,y:0};}else predictionOffset={x:0,y:0};}
}
function handleEvents(events:GameEvent[]){for(const event of events){if(seenEvents.has(event.id))continue;seenEvents.add(event.id);renderer.event(event);if(event.type==='shot'&&event.actorId===myId)audio.noise();if(event.type==='loot'&&event.actorId===myId)audio.tone(680);if(event.type==='land'&&event.actorId===myId){audio.stopWind();audio.noise(.25,.14);}if(event.type==='ground')audio.stopWind();if(event.type==='hit'&&event.actorId===myId)audio.tone(130,'sawtooth',.07,.04);}if(seenEvents.size>3000){const keep=[...seenEvents].slice(-1500);seenEvents.clear();for(const id of keep)seenEvents.add(id);}}
function showResult(outcome:Outcome,reason:string,kills:number,loot:number,practice:boolean,allowSpectate=false){
  if(!resultPresented){
    let reward=0;if(practice){const survived=practiceGroundStarted?Math.max(0,CONSTANTS.GROUND_TIME-(snapshot?.time||0)):0;reward=store.settlePractice(outcome,reason,kills,loot,survived);}else store.recordOnline(matchId,outcome,kills);
    const titles:Record<Outcome,string>={win:reason==='portal'?'PORTAL ESCAPE!':'WINNER WINNER!',survived:'TIME OVER',death:'GAME OVER',defeated:'MATCH OVER',left:'대전에서 나왔습니다',interrupted:'대전이 중단되었습니다'};
    text('result-title',titles[outcome]);text('result-mode',practice?'PRACTICE RESULT':'ONLINE RESULT');
    const description=outcome==='interrupted'?'연결 또는 운영 사유로 대전이 중단되었습니다.\n온라인 기록에 반영되지 않습니다.':`${outcome==='win'?'승리했습니다!':outcome==='survived'?'끝까지 살아남았습니다.':outcome==='defeated'?'다른 플레이어가 탈출했습니다.':'다음 강하를 준비하세요.'}\n처치 ${kills} · 파밍 ${loot}${practice?`\n+${reward} G · STAGE ${store.save.stage}`:'\n모든 플레이어는 같은 능력치로 대전합니다.'}`;
    text('result-description',description);resultPresented=true;refreshTraining();
  }
  audio.stopWind();neutralInput();show('spectate-btn',allowSpectate);setMode('result');
}
function receiveMatchResult(result:MatchResult){
  matchEnded=true;show('spectate-btn',false);const own=snapshot?.entities.find(e=>e.id===myId),outcome=result.outcomes[String(myId)]||'interrupted';
  if(resultPresented&&outcome==='win')text('result-title',result.reason==='portal'?'PORTAL ESCAPE!':'WINNER WINNER!');
  if(!resultPresented||mode==='spectator')showResult(outcome,result.reason,own?.kills||0,own?.lootCount||0,lastMode==='practice',false);
}
network.onStatus=status=>{text('online-status',status);text('connection-state',status==='연결됨'?'':status);};
network.onFailure=message=>{network.close();if(snapshot){matchEnded=true;showResult('interrupted','interrupted',0,0,false);}else{setMode('menu');text('online-status',message);}toast(message);};
network.onMessage=(message:ServerMessage)=>{
  if(message.type==='welcome'){
    const changed=matchId!==message.matchId;myId=message.playerId;matchId=message.matchId;generation=message.generation;lobbyEndsAt=message.lobbyEndsAt;roster=message.players;
    if(changed){snapshot=null;previousSnapshot=null;history=[];seq=0;seenEvents.clear();resultPresented=false;matchEnded=false;}
    if(!snapshot)setMode('lobby');updateLobby();return;
  }
  if(message.type==='roster'){roster=message.players;lobbyEndsAt=message.lobbyEndsAt;updateLobby();return;}
  if(message.type==='start'){
    if(message.matchId!==matchId||message.generation!==generation)return;map=message.map;roster=message.roster;acceptSnapshot(unpackSnapshot(message.snapshot),0);setMode('online');audio.startWind();updateHud();return;
  }
  if(message.type==='state'){
    if(message.matchId!==matchId||message.generation!==generation)return;acceptSnapshot(unpackSnapshot(message.snapshot),message.ack);handleEvents(message.events);if(mode==='lobby'||mode==='joining')setMode('online');
    if(snapshot?.ended&&snapshot.result)receiveMatchResult(snapshot.result);updateHud();return;
  }
  if(message.type==='player_result'){
    if(message.matchId!==matchId||message.playerId!==myId)return;showResult(message.outcome,'death',message.kills,message.lootCount,false,!matchEnded&&network.connected);return;
  }
  if(message.type==='match_result'){if(message.matchId===matchId)receiveMatchResult(message.result);return;}
  if(message.type==='closed'||message.type==='error'){
    const reason=friendlyNetworkReason(message.reason,message.resetAt);network.close();if(!matchEnded&&snapshot){matchEnded=true;showResult('interrupted','interrupted',0,0,false);}else if(!snapshot){setMode('menu');text('online-status',reason);}if(!matchEnded)toast(reason);
  }
};
function updateLobby(){
  const humans=roster.filter(p=>!p.bot).length;text('lobby-count',`사람 ${humans}명 · 봇 ${Math.max(0,10-humans)}명`);const seconds=Math.max(0,Math.ceil((lobbyEndsAt-Date.now())/1000));text('lobby-timer',seconds>0?`${seconds}초 후 강하합니다`:'강하를 준비하고 있습니다…');
  const container=el('lobby-roster');container.replaceChildren();for(const player of roster.filter(p=>!p.bot)){const chip=document.createElement('span');chip.className='roster-chip';chip.style.borderLeft=`3px solid ${player.color}`;chip.textContent=player.nick+(player.id===myId?' (나)':'');container.appendChild(chip);}
}
function updateHud(){
  if(!snapshot)return;const own=snapshot.entities.find(e=>e.id===myId);if(!own)return;
  const humans=roster.filter(p=>!p.bot).length,bots=roster.filter(p=>p.bot).length;
  text('mode-badge',`${lastMode==='practice'?'훈련소 연습':'온라인 · 동등한 능력치'} · 사람 ${humans} / 봇 ${bots}`);
  text('phase-text',snapshot.phase==='DROPPING'?'공중 강하!':snapshot.phase==='GROUND'?'전투 시작!':'대전 종료');text('timer-display',String(Math.max(0,Math.ceil(snapshot.time))));text('alive-counter',`생존 ${snapshot.entities.filter(e=>e.alive).length} · 킬 ${own.kills}`);
  text('altitude-display',`고도 ${Math.ceil(own.z)}pt`);text('weapon-display',`무기 ${WEAPONS[own.weapon].name}${own.weapon==='GUN'?` (${own.ammo})`:''}`);text('loot-count-display',`파밍 ${own.lootCount} / 7`);text('hp-value',`${Math.ceil(own.hp)} / ${own.maxHp}`);
  el('hp-bar').style.width=`${Math.max(0,own.hp/own.maxHp*100)}%`;el('hp-bar').style.background=own.hp/own.maxHp<.3?'#ef4d42':'#22c964';el('st-bar').style.width=`${Math.max(0,own.stamina)}%`;el('st-bar').style.background=own.fatigued?'#a8afb7':'#ffd54e';show('dive-btn',own.z>0&&own.alive&&['practice','online'].includes(mode));
  el('damage-overlay').style.opacity=snapshot.phase==='GROUND'&&own.alive&&Math.hypot(own.x-snapshot.safeZone.currentX,own.y-snapshot.safeZone.currentY)>snapshot.safeZone.currentR?'.5':'0';
  const identities=new Map(roster.map(p=>[p.id,p]));const leaderboard=el('leaderboard-content');leaderboard.replaceChildren();for(const actor of [...snapshot.entities].sort((a,b)=>Number(b.alive)-Number(a.alive)||b.kills-a.kills)){
    const row=document.createElement('div');row.className='leaderboard-row'+(actor.id===myId?' mine':'')+(!actor.alive?' dead':'');const nick=document.createElement('span'),kills=document.createElement('span');nick.textContent=(actor.bot?'BOT · ':'')+(identities.get(actor.id)?.nick||'PLAYER')+(actor.id===myId?' (나)':'');kills.textContent=String(actor.kills);row.appendChild(nick);row.appendChild(kills);leaderboard.appendChild(row);
  }
}
function interpolate(now:number):Snapshot|null{
  if(!snapshot||lastMode!=='online')return snapshot;
  const fraction=Math.min(1,Math.max(0,(now-lastSnapshotAt)/100)),old=new Map(previousSnapshot?.entities.map(e=>[e.id,e])||[]);
  const entities=snapshot.entities.map(actor=>{
    if(actor.id===myId&&predicted&&actor.alive)return {...actor,x:predicted.x+predictionOffset.x,y:predicted.y+predictionOffset.y,angle:readInput().aim};
    const before=old.get(actor.id);if(!before||before.alive!==actor.alive)return actor;
    let angle=actor.angle-before.angle;while(angle>Math.PI)angle-=Math.PI*2;while(angle< -Math.PI)angle+=Math.PI*2;
    return {...actor,x:before.x+(actor.x-before.x)*fraction,y:before.y+(actor.y-before.y)*fraction,z:before.z+(actor.z-before.z)*fraction,angle:before.angle+angle*fraction};
  });
  return {...snapshot,entities};
}
function practiceStep(dt:number){
  if(!simulation||mode!=='practice')return;
  simulation.setInput(myId,readInput(true));simulation.tick(dt);snapshot=simulation.snapshot();if(snapshot.phase==='GROUND')practiceGroundStarted=true;handleEvents(simulation.drainEvents());
  if(snapshot.ended&&snapshot.result)receiveMatchResult(snapshot.result);
}
function frame(now:number){
  const dt=Math.min(.1,Math.max(0,(now-lastFrame)/1000));lastFrame=now;
  if(mode==='practice'){
    accumulator+=dt;let steps=0;while(accumulator>=FIXED_STEP&&steps++<8&&mode==='practice'){practiceStep(FIXED_STEP);accumulator-=FIXED_STEP;}updateHud();
  }else if(mode==='online'&&predicted&&performance.now()-lastSnapshotAt<500){
    Object.assign(predicted,predictMovement(predicted,readInput(),map,dt));const fade=Math.max(0,1-dt/0.12);predictionOffset.x*=fade;predictionOffset.y*=fade;
  }
  if(lastMode==='online')sendInput();
  if(mode==='lobby')updateLobby();
  const view=interpolate(now),spectating=mode==='spectator'||(mode==='result'&&lastMode==='online');const focus=spectating?view?.entities.find(e=>e.alive&&!e.bot)||view?.entities.find(e=>e.alive):undefined;
  renderer.draw(view,map,roster,myId,dt,focus?.id);requestAnimationFrame(frame);
}

el('start-btn').onclick=startPractice;el('online-btn').onclick=()=>void joinOnline();el('cancel-join-btn').onclick=()=>menu();el('join-cancel-btn').onclick=()=>menu();el('leave-btn').onclick=()=>menu();el('result-home-btn').onclick=()=>menu();el('again-btn').onclick=()=>{if(lastMode==='practice')startPractice();else void joinOnline();};
el('spectate-btn').onclick=()=>{neutralInput();setMode('spectator');};el('home-link').onclick=event=>{event.preventDefault();menu();};
el('training-toggle').onclick=()=>setTraining(!trainingOpen);el('lab-close').onclick=()=>setTraining(false);el('offline-claim').onclick=()=>show('offline-popup',false);
el('sound-btn').onclick=()=>{const on=audio.toggle();text('sound-btn',on?'소리 켜짐':'소리 꺼짐');el('sound-btn').setAttribute('aria-pressed',String(on));};
const dive=el('dive-btn');dive.onpointerdown=event=>{event.preventDefault();dive.setPointerCapture(event.pointerId);keys.add('ShiftLeft');};dive.onpointerup=()=>keys.delete('ShiftLeft');dive.onpointercancel=()=>keys.delete('ShiftLeft');
document.addEventListener('keydown',event=>{
  if(event.target instanceof HTMLInputElement)return;
  if(event.code==='KeyF'&&!event.repeat){event.preventDefault();void (document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen()).catch(()=>toast('전체 화면을 사용할 수 없습니다.'));return;}
  if(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','ShiftLeft','ShiftRight'].includes(event.code)&&['practice','online'].includes(mode)){event.preventDefault();keys.add(event.code);}
});
document.addEventListener('keyup',event=>keys.delete(event.code));
renderer.canvas.addEventListener('pointermove',event=>{mouse.x=event.clientX;mouse.y=event.clientY;});
renderer.canvas.addEventListener('pointerdown',event=>{if(event.button!==0||!['practice','online'].includes(mode))return;audio.init();mouse.held=true;mouse.firePressed=true;mouse.x=event.clientX;mouse.y=event.clientY;});
window.addEventListener('pointerup',()=>{mouse.held=false;});window.addEventListener('blur',neutralInput);
document.addEventListener('visibilitychange',()=>{if(document.hidden){neutralInput();store.persist();}else{const gold=store.collectOffline();if(gold>0){text('offline-msg',`자리를 비운 동안 +${gold.toLocaleString()} G\n최대 8시간까지 적립됩니다.`);show('offline-popup',true);refreshTraining();}}});
window.addEventListener('pagehide',()=>{neutralInput();store.persist();});
window.setInterval(()=>{if(mode==='menu'||mode==='result'){if(store.tickHub(.25))refreshTraining();}},250);
el<HTMLInputElement>('nick-input').value=store.save.nick;const offlineGold=store.collectOffline();refreshTraining();if(offlineGold>0){text('offline-msg',`자리를 비운 동안 +${offlineGold.toLocaleString()} G\n최대 8시간까지 적립됩니다.`);show('offline-popup',true);}if(!store.storageAvailable)toast('이 브라우저에서 저장할 수 없습니다. 브라우저 설정을 확인해주세요.');
void readOnlineConfig().then(value=>{config=value;text('online-status',value.apiUrl?'실제 사람과 최대 10명이 함께 대전합니다.':'온라인 연결이 아직 준비되지 않았습니다. 연습 플레이는 바로 이용할 수 있습니다.');el<HTMLButtonElement>('online-btn').disabled=!value.apiUrl;});
setMode('menu');requestAnimationFrame(frame);

declare global {interface Window {render_game_to_text:()=>string;advanceTime:(ms:number)=>void}}
window.render_game_to_text=()=>JSON.stringify({coordinates:'World origin at top-left, x right, y down; altitude z positive above ground.',mode,matchMode:lastMode,phase:snapshot?.phase||'MENU',tick:snapshot?.tick||0,time:snapshot?.time||0,myId,matchId,generation,onlineReady:!!config.apiUrl,connected:network.connected,humans:roster.filter(p=>!p.bot).length,bots:roster.filter(p=>p.bot).length,player:snapshot?.entities.find(e=>e.id===myId)||null,entities:snapshot?.entities||[],loot:snapshot?.loot||[],bullets:snapshot?.bullets||[],zone:snapshot?.safeZone||null,portal:snapshot?.portal||null,ended:snapshot?.ended||false,result:snapshot?.result||null,practice:{gold:store.save.gold,stage:store.save.stage,levels:store.save.levels},onlineRecords:store.save.online});
window.advanceTime=(ms:number)=>{if(mode!=='practice'||!Number.isFinite(ms)||ms<=0)return;const steps=Math.min(36000,Math.max(1,Math.round(ms/(1000/60))));for(let i=0;i<steps&&mode==='practice';i++)practiceStep(FIXED_STEP);lastFrame=performance.now();accumulator=0;updateHud();renderer.draw(snapshot,map,roster,myId,0);};
