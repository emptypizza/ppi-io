import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnlineSession } from './network';

class FakeSocket {
  static OPEN=1;static instances:FakeSocket[]=[];
  readyState=0;bufferedAmount=0;
  onmessage:((event:{data:string})=>void)|null=null;onclose:(()=>void)|null=null;onerror:(()=>void)|null=null;
  sent:string[]=[];
  constructor(readonly url:string){FakeSocket.instances.push(this);}
  receive(data:object){this.readyState=1;this.onmessage?.({data:JSON.stringify(data)});}
  close(){this.readyState=3;this.onclose?.();}
  send(data:string){this.sent.push(data);}
}
const welcome=(resumeToken='resume-1')=>({type:'welcome',playerId:0,roomId:'room-1',generation:1,matchId:'match-1',resumeToken,deadline:Date.now()+90_000,lobbyEndsAt:Date.now()+10_000,players:[{id:0,nick:'QA',color:'#00BFFF',bot:false}]});

describe('online connection lifecycle',()=>{
  let session:OnlineSession;
  beforeEach(()=>{
    vi.useFakeTimers();FakeSocket.instances=[];
    vi.stubGlobal('window',globalThis);vi.stubGlobal('location',{hostname:'127.0.0.1'});vi.stubGlobal('WebSocket',FakeSocket);
    vi.stubGlobal('fetch',vi.fn(async(input:string|URL)=>String(input).includes('/api/result')
      ?Response.json({matchId:'match-1',result:null,player:{matchId:'match-1',playerId:0,outcome:'death',kills:2,lootCount:1}})
      :Response.json({roomId:'room-1',generation:1,matchId:'match-1',ticket:'ticket-1',wsUrl:'ws://127.0.0.1:8787/api/ws?ticket=ticket-1',deadline:Date.now()+90_000})));
    session=new OnlineSession();
  });
  afterEach(()=>{session.close();vi.useRealTimers();vi.unstubAllGlobals();});
  async function connect(){
    const joining=session.join({apiUrl:'http://127.0.0.1:8787',turnstileSiteKey:''},'QA','#00BFFF',{} as HTMLElement);
    await vi.advanceTimersByTimeAsync(0);FakeSocket.instances[0].receive(welcome());await joining;
  }
  it('does not mistake a quiet ten-second lobby for a dead connection',async()=>{
    await connect();await vi.advanceTimersByTimeAsync(11_000);
    expect(session.connected).toBe(true);expect(FakeSocket.instances).toHaveLength(1);
  });
  it('ignores late events from an old socket after a successful resume',async()=>{
    await connect();const first=FakeSocket.instances[0],lateClose=first.onclose!,lateMessage=first.onmessage!;
    first.close();await vi.advanceTimersByTimeAsync(400);const replacement=FakeSocket.instances[1];replacement.receive(welcome('resume-2'));
    lateClose();lateMessage({data:JSON.stringify(welcome('obsolete-resume'))});await vi.advanceTimersByTimeAsync(2000);
    expect(session.connected).toBe(true);expect(FakeSocket.instances).toHaveLength(2);
    replacement.close();await vi.advanceTimersByTimeAsync(900);
    expect(new URL(FakeSocket.instances[2].url).searchParams.get('resume')).toBe('resume-2');
  });
  it('caps resumes at three per match and recovers an authoritative cached result',async()=>{
    const onMessage=vi.fn(),onFailure=vi.fn();session.onMessage=onMessage;session.onFailure=onFailure;await connect();
    for(let index=0;index<3;index++){
      FakeSocket.instances[index].close();await vi.advanceTimersByTimeAsync([400,900,1600][index]);
      FakeSocket.instances[index+1].receive(welcome('resume-'+(index+2)));
    }
    FakeSocket.instances[3].close();await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.instances).toHaveLength(4);
    expect(vi.mocked(fetch).mock.calls.filter(call=>String(call[0]).includes('/api/result'))).toHaveLength(1);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({type:'player_result',matchId:'match-1',outcome:'death',kills:2}));
    expect(onFailure).not.toHaveBeenCalled();
  });
});
