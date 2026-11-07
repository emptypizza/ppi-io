import { BUILD_ID, PROTOCOL_VERSION, type InputFrame, type JoinReply, type MatchResult, type PlayerResult, type ServerMessage } from '../shared/protocol';

export interface OnlineConfig { apiUrl:string; turnstileSiteKey:string }
interface TurnstileAPI { render:(container:HTMLElement,options:Record<string,unknown>)=>string; remove:(id:string)=>void }
declare global { interface Window { turnstile?:TurnstileAPI } }
const localHost = () => ['localhost','127.0.0.1','[::1]'].includes(location.hostname);
export async function readOnlineConfig():Promise<OnlineConfig> {
  try {
    const response=await fetch(import.meta.env.BASE_URL+'config.json',{cache:'no-store'});
    if(!response.ok)return {apiUrl:'',turnstileSiteKey:''};
    const data=await response.json() as Partial<OnlineConfig>;
    const url=typeof data.apiUrl==='string'?data.apiUrl.trim().replace(/\/+$/,''):'';
    if(url){const parsed=new URL(url);if(parsed.protocol!=='https:'&&!(localHost()&&['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)&&parsed.protocol==='http:'))return {apiUrl:'',turnstileSiteKey:''};}
    return {apiUrl:url,turnstileSiteKey:typeof data.turnstileSiteKey==='string'?data.turnstileSiteKey:''};
  } catch {return {apiUrl:'',turnstileSiteKey:''};}
}
let scriptPromise:Promise<void>|null=null;
async function challengeToken(siteKey:string,container:HTMLElement,signal:AbortSignal):Promise<string>{
  if(!siteKey){if(localHost())return '';throw new Error('온라인 연결이 아직 준비되지 않았습니다. 연습 플레이를 이용해주세요.');}
  if(!window.turnstile){
    scriptPromise??=new Promise<void>((resolve,reject)=>{const script=document.createElement('script');script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';script.async=true;script.defer=true;script.onload=()=>resolve();script.onerror=()=>{scriptPromise=null;reject(new Error('접속 확인을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.'));};document.head.appendChild(script);});
    await scriptPromise;
  }
  if(signal.aborted)throw new DOMException('Join cancelled','AbortError');
  if(!window.turnstile)throw new Error('접속 확인을 시작하지 못했습니다.');
  return new Promise<string>((resolve,reject)=>{
    let widget='';let settled=false;
    const finish=(token?:string)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',onAbort);if(widget)window.turnstile?.remove(widget);container.replaceChildren();if(token)resolve(token);else reject(new Error('접속 확인이 만료되었습니다. 다시 시도해주세요.'));};
    const onAbort=()=>finish();signal.addEventListener('abort',onAbort,{once:true});
    const timer=window.setTimeout(()=>finish(),90000);
    widget=window.turnstile!.render(container,{sitekey:siteKey,action:'ppi-io-join',theme:'dark',callback:(token:string)=>finish(token),'error-callback':()=>{finish();return true;},'expired-callback':()=>finish()});
  });
}
export function friendlyNetworkReason(reason:string,resetAt?:number):string{
  if(/budget|quota|capacity|limit|busy/.test(reason))return '무료 온라인 이용량이 가득 찼습니다.'+(resetAt?' '+new Date(resetAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})+' 이후 다시 시도해주세요.':' 잠시 후 다시 시도해주세요.');
  if(/protocol|version|build/.test(reason))return '게임이 업데이트되었습니다. 새로고침 후 다시 접속해주세요.';
  if(/turnstile|challenge|verification/.test(reason))return '접속 확인을 완료하지 못했습니다. 다시 시도해주세요.';
  if(/expired|ticket|resume|generation/.test(reason))return '접속 시간이 만료되었습니다. 새 대전을 시작해주세요.';
  if(/full|started/.test(reason))return '이 대전은 이미 시작됐습니다. 새 대전을 찾아주세요.';
  if(/interrupted|restart|shutdown/.test(reason))return '대전이 중단되었습니다. 기록에는 반영되지 않습니다.';
  return '온라인 연결이 끊겼습니다. 잠시 후 다시 시도해주세요.';
}
export class OnlineSession {
  onMessage:(message:ServerMessage)=>void=()=>{};
  onStatus:(status:string)=>void=()=>{};
  onFailure:(message:string)=>void=()=>{};
  private socket:WebSocket|null=null;
  private controller:AbortController|null=null;
  private intentional=false;
  private epoch=0;
  private reconnectTimer=0;
  private attempts=0;
  private resumeToken='';
  private apiUrl='';
  private lastMessageAt=0;
  private watchdog=0;
  private recovering=false;
  matchId='';roomId='';generation=0;playerId=0;deadline=0;lobbyEndsAt=0;
  get connected(){return this.socket?.readyState===WebSocket.OPEN;}
  async join(config:OnlineConfig,nick:string,color:string,container:HTMLElement){
    this.close();this.intentional=false;const epoch=++this.epoch;this.apiUrl=config.apiUrl;
    if(!config.apiUrl)throw new Error('온라인 연결이 아직 준비되지 않았습니다. 연습 플레이는 바로 이용할 수 있습니다.');
    this.onStatus('접속 확인 중…');
    const controller=new AbortController();this.controller=controller;
    const token=await challengeToken(config.turnstileSiteKey,container,controller.signal);
    if(epoch!==this.epoch)return;
    const timeout=window.setTimeout(()=>controller.abort(),15000);
    let reply:JoinReply;
    try{
      const response=await fetch(config.apiUrl+'/api/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({protocol:PROTOCOL_VERSION,build:BUILD_ID,nick,color,challengeToken:token,requestId:crypto.randomUUID()}),signal:controller.signal});
      const body=await response.json() as JoinReply&{reason?:string;error?:string;resetAt?:number};
      if(!response.ok)throw new Error(friendlyNetworkReason(body.reason||body.error||String(response.status),body.resetAt));
      reply=body;
    }finally{clearTimeout(timeout);}
    if(epoch!==this.epoch)return;
    this.matchId=reply.matchId;this.roomId=reply.roomId;this.generation=reply.generation;this.deadline=reply.deadline;
    let url=new URL(reply.wsUrl||'/api/ws',this.apiUrl);url.protocol=url.protocol==='https:'?'wss:':url.protocol==='http:'?'ws:':url.protocol;
    if(!url.searchParams.has('ticket'))url.searchParams.set('ticket',reply.ticket);
    this.onStatus('대전에 입장 중…');await this.connect(url.href,epoch,false);
  }
  private connect(url:string,epoch:number,resuming:boolean):Promise<void>{
    return new Promise<void>((resolve,reject)=>{
      if(epoch!==this.epoch){resolve();return;}
      const previous=this.socket;if(previous){previous.onmessage=null;previous.onclose=null;previous.onerror=null;if(previous.readyState<2)previous.close();}
      const socket=new WebSocket(url);this.socket=socket;let welcomed=false;
      const isActive=()=>epoch===this.epoch&&this.socket===socket;
      const timeout=window.setTimeout(()=>{if(!isActive())return;socket.close();if(!welcomed)reject(new Error('접속 시간이 초과되었습니다. 다시 시도해주세요.'));},10000);
      socket.onmessage=event=>{
        if(!isActive())return;
        this.lastMessageAt=performance.now();let message:ServerMessage;
        try{message=JSON.parse(String(event.data)) as ServerMessage;}catch{return;}
        if(message.type==='welcome'){
          welcomed=true;clearTimeout(timeout);if(!resuming)this.attempts=0;this.resumeToken=message.resumeToken;this.playerId=message.playerId;this.matchId=message.matchId;this.roomId=message.roomId;this.generation=message.generation;this.deadline=message.deadline;this.lobbyEndsAt=message.lobbyEndsAt;
          this.onStatus(resuming?'다시 연결되었습니다.':'연결됨');resolve();
          clearInterval(this.watchdog);this.watchdog=window.setInterval(()=>{if(this.socket?.readyState===WebSocket.OPEN&&performance.now()-this.lastMessageAt>15000&&Date.now()>this.lobbyEndsAt+3000)this.socket.close();},2000);
        }
        if(message.type==='closed'||message.type==='error'){
          this.intentional=true;clearTimeout(timeout);clearInterval(this.watchdog);
          if(!welcomed)reject(new Error(friendlyNetworkReason(message.reason,message.resetAt)));
        }
        this.onMessage(message);
      };
      socket.onerror=()=>{if(!isActive())return;if(!welcomed){clearTimeout(timeout);reject(new Error('온라인에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.'));}};
      socket.onclose=()=>{
        if(!isActive())return;clearTimeout(timeout);clearInterval(this.watchdog);if(this.intentional)return;
        if(!welcomed&&!resuming&&!this.resumeToken){reject(new Error('대전에 연결하지 못했습니다.'));return;}
        this.scheduleResume(epoch);
      };
    });
  }
  private scheduleResume(epoch:number){
    if(this.intentional||epoch!==this.epoch||this.reconnectTimer)return;
    if(!this.resumeToken){this.onFailure('다시 연결하지 못했습니다. 대전 결과는 중복 기록되지 않습니다.');return;}
    if(this.attempts>=3){void this.recoverResult(epoch);return;}
    const attempt=++this.attempts;this.onStatus(`다시 연결 중… (${attempt}/3)`);
    clearTimeout(this.reconnectTimer);this.reconnectTimer=window.setTimeout(()=>{
      this.reconnectTimer=0;
      const url=new URL('/api/ws',this.apiUrl);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.searchParams.set('resume',this.resumeToken);
      void this.connect(url.href,epoch,true).catch(()=>{if(epoch===this.epoch&&!this.intentional&&!this.connected)this.scheduleResume(epoch);});
    },[0,400,900,1600][attempt]);
  }
  private async recoverResult(epoch:number){
    if(this.recovering||this.intentional||epoch!==this.epoch)return;
    this.recovering=true;this.onStatus('대전 결과를 확인하고 있습니다…');
    try{
      for(let attempt=0;attempt<3;attempt++){
        if(epoch!==this.epoch||this.intentional)return;
        if(attempt)await new Promise(resolve=>window.setTimeout(resolve,1000));
        const url=new URL('/api/result',this.apiUrl);url.searchParams.set('resume',this.resumeToken);url.searchParams.set('matchId',this.matchId);
        let response:Response;try{response=await fetch(url,{signal:AbortSignal.timeout(5000)});}catch{continue;}
        if(response.status===202)continue;
        if(!response.ok)break;
        const result=await response.json() as {matchId:string;player?:PlayerResult;result?:MatchResult|null};
        if(epoch!==this.epoch||this.intentional)return;
        if(result.matchId!==this.matchId||(!result.player&&!result.result))break;
        this.intentional=true;
        if(result.player)this.onMessage({type:'player_result',...result.player});
        if(result.result)this.onMessage({type:'match_result',matchId:result.matchId,result:result.result});
        this.onStatus('대전 결과를 복구했습니다.');return;
      }
      if(epoch===this.epoch&&!this.intentional)this.onFailure('다시 연결하지 못했습니다. 대전 결과를 확인할 수 없어 기록에 반영하지 않습니다.');
    }finally{this.recovering=false;}
  }
  send(frame:InputFrame){if(this.socket?.readyState!==WebSocket.OPEN)return false;if(this.socket.bufferedAmount>16384)return false;this.socket.send(JSON.stringify(frame));return true;}
  close(){this.intentional=true;this.epoch++;clearTimeout(this.reconnectTimer);this.reconnectTimer=0;clearInterval(this.watchdog);this.controller?.abort();this.controller=null;this.socket?.close();this.socket=null;this.resumeToken='';this.attempts=0;this.recovering=false;}
}
