import { describe, it, expect } from 'vitest';
import { packSnapshot, unpackSnapshot, type Snapshot } from './protocol';
import { GameSim } from './simulation';
describe('network state serialization', () => {
  it('round trips actor flags and object identities without private roster metadata', () => {
    const state: Snapshot = { tick: 90, phase:'GROUND',time:52.1,entities:[{id:1,bot:false,x:14.2,y:25.3,z:0,angle:1.25,hp:370,maxHp:400,stamina:65.2,fatigued:true,alive:true,weapon:'GUN',ammo:25,kills:1,lootCount:2,isDiving:false}],bullets:[{id:3,x:40,y:50,angle:1.5}],loot:[{id:8,x:90,y:100,type:'KNIFE'}],craters:[{id:1,x:10,y:20,radius:60,alpha:0.5}],safeZone:{currentX:1500,currentY:1500,currentR:900},portal:{active:true,x:800,y:900,radius:60,timer:5},ended:false,result:null };
    expect(unpackSnapshot(packSnapshot(state))).toEqual(state);
    expect(JSON.stringify(packSnapshot(state))).not.toContain('nick');
  });
  it('keeps 95 percent of ten-player state packets within the 4 KiB budget', () => {
    const sizes: number[] = [];
    for (let seed = 1; seed <= 5; seed++) {
      const sim = new GameSim({seed,humans:Array.from({length:10},(_,id)=>({id,nick:`PLAYER ${id}`,color:'#00BFFF'})),bots:0});
      for (const actor of sim.entities) { actor.weapon='GUN';actor.ammo=30; }
      for (let tick = 0; tick < 1800 && !sim.ended; tick++) {
        for (const actor of sim.entities) if (!tick || tick%6===0) sim.setInput(actor.id,{seq:tick,dx:Math.sin(tick/60+actor.id),dy:Math.cos(tick/60+actor.id),aim:actor.id*.6,attack:true,firePressed:false,sprint:false});
        sim.tick(1/60);
        if (tick%6===0) sizes.push(new TextEncoder().encode(JSON.stringify({type:'state',matchId:'room-1-100-00000000-0000-0000-0000-000000000000',generation:100,snapshot:packSnapshot(sim.snapshot()),events:sim.drainEvents(),ack:tick})).byteLength);
      }
    }
    sizes.sort((a,b)=>a-b);
    expect(sizes.length).toBeGreaterThan(100);
    expect(sizes[Math.floor(sizes.length*.95)]).toBeLessThanOrEqual(4096);
  });
});
