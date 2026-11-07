export const PROTOCOL_VERSION = 1 as const;
export const BUILD_ID = '0.1.0';
export const FIXED_STEP = 1 / 60;
export const COLORS = ['#00BFFF', '#76FF03', '#FFD54F', '#E040FB', '#EEEEEE'] as const;
export type Weapon = 'NONE' | 'KNIFE' | 'GUN' | 'SHIELD';
export type Phase = 'DROPPING' | 'GROUND' | 'END';
export type Outcome = 'win' | 'survived' | 'death' | 'defeated' | 'left' | 'interrupted';
export interface Loadout { levels: number[]; stage: number }
export interface Participant { id: number; nick: string; color: string; loadout?: Loadout }
export interface Identity { id: number; nick: string; color: string; bot: boolean }
export interface InputFrame { type: 'input'; seq: number; dx: number; dy: number; aim: number; attack: boolean; firePressed: boolean; sprint: boolean }
export type GameInput = Omit<InputFrame, 'type' | 'seq'> & { seq?: number };
export interface ActorState { id: number; bot: boolean; x: number; y: number; z: number; angle: number; hp: number; maxHp: number; stamina: number; fatigued: boolean; alive: boolean; weapon: Weapon; ammo: number; kills: number; lootCount: number; isDiving: boolean }
export interface MapProp { id: number; x: number; y: number; width: number; height: number; type: 'BUILDING' | 'ROCK' }
export interface BulletState { id: number; x: number; y: number; angle: number }
export interface LootState { id: number; x: number; y: number; type: Weapon }
export interface CraterState { id: number; x: number; y: number; radius: number; alpha: number }
export interface SafeZone { currentX: number; currentY: number; currentR: number }
export interface Portal { active: boolean; x: number; y: number; radius: number; timer: number }
export interface MatchResult { reason: 'portal' | 'last' | 'all_humans_dead' | 'time' | 'interrupted'; winnerId: number | null; outcomes: Record<string, Outcome> }
export interface GameEvent { id: number; type: string; x: number; y: number; actorId?: number; targetId?: number; color?: string; value?: number }
export interface Snapshot { tick: number; phase: Phase; time: number; entities: ActorState[]; bullets: BulletState[]; loot: LootState[]; craters: CraterState[]; safeZone: SafeZone; portal: Portal; ended: boolean; result: MatchResult | null }
export interface MatchOptions { seed: number; humans: Participant[]; bots?: number; stage?: number; practice?: boolean }
export interface JoinRequest { protocol: number; build: string; nick: string; color: string; challengeToken: string; requestId: string }
export interface JoinReply { roomId: string; generation: number; matchId: string; ticket: string; wsUrl: string; deadline: number }
export interface PlayerResult { matchId: string; playerId: number; outcome: Outcome; kills: number; lootCount: number }
export interface WireSnapshot { t: number; p: number; s: number; e: number[][]; b: number[][]; l: number[][]; c: number[][]; z: number[]; o: number[]; r: MatchResult | null }
const weapons: Weapon[] = ['NONE', 'KNIFE', 'GUN', 'SHIELD'];
const round = (n: number) => Math.round(n * 10) / 10;
export function packSnapshot(s: Snapshot): WireSnapshot {
  return {
    t: s.tick, p: ['DROPPING', 'GROUND', 'END'].indexOf(s.phase), s: round(s.time),
    e: s.entities.map(e => [e.id,round(e.x),round(e.y),round(e.z),Math.round(e.angle*1000)/1000,round(e.hp),e.maxHp,round(e.stamina),(e.alive?1:0)|(e.bot?2:0)|(e.fatigued?4:0)|(e.isDiving?8:0),weapons.indexOf(e.weapon),e.ammo,e.kills,e.lootCount]),
    b: s.bullets.map(b => [b.id,round(b.x),round(b.y),Math.round(b.angle*1000)/1000]),
    l: s.loot.map(l => [l.id,round(l.x),round(l.y),weapons.indexOf(l.type)]),
    c: s.craters.map(c => [c.id,round(c.x),round(c.y),round(c.radius),Math.round(c.alpha*100)/100]),
    z: [round(s.safeZone.currentX),round(s.safeZone.currentY),round(s.safeZone.currentR)],
    o: [s.portal.active?1:0,round(s.portal.x),round(s.portal.y),s.portal.radius,round(s.portal.timer)], r:s.result
  };
}
export function unpackSnapshot(w: WireSnapshot): Snapshot {
  return { tick:w.t,phase:(['DROPPING','GROUND','END'] as Phase[])[w.p],time:w.s,
    entities:w.e.map(e=>({id:e[0],x:e[1],y:e[2],z:e[3],angle:e[4],hp:e[5],maxHp:e[6],stamina:e[7],alive:!!(e[8]&1),bot:!!(e[8]&2),fatigued:!!(e[8]&4),isDiving:!!(e[8]&8),weapon:weapons[e[9]],ammo:e[10],kills:e[11],lootCount:e[12]})),
    bullets:w.b.map(b=>({id:b[0],x:b[1],y:b[2],angle:b[3]})),loot:w.l.map(l=>({id:l[0],x:l[1],y:l[2],type:weapons[l[3]]})),
    craters:w.c.map(c=>({id:c[0],x:c[1],y:c[2],radius:c[3],alpha:c[4]})),
    safeZone:{currentX:w.z[0],currentY:w.z[1],currentR:w.z[2]},portal:{active:!!w.o[0],x:w.o[1],y:w.o[2],radius:w.o[3],timer:w.o[4]},ended:w.p===2,result:w.r };
}
export type ServerMessage =
  | { type:'welcome';roomId:string;generation:number;matchId:string;playerId:number;resumeToken:string;deadline:number;lobbyEndsAt:number;players:Identity[] }
  | { type:'roster';players:Identity[];lobbyEndsAt:number }
  | { type:'start';matchId:string;generation:number;map:MapProp[];roster:Identity[];snapshot:WireSnapshot }
  | { type:'state';matchId:string;generation:number;snapshot:WireSnapshot;events:GameEvent[];ack:number }
  | ({type:'player_result'} & PlayerResult)
  | {type:'match_result';matchId:string;result:MatchResult}
  | {type:'closed';reason:string;resetAt?:number}
  | {type:'error';reason:string;resetAt?:number};
