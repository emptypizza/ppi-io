import { describe, expect, it } from 'vitest';
import { FIXED_STEP } from './protocol';
import type { GameInput } from './protocol';
import { Bullet, CONSTANTS, GameSim, LootBox, MapObject, mulberry32, predictMovement, segmentCircle } from './simulation';

const human = (id: number) => ({ id, nick: `P${id}`, color: '#00BFFF' });
const input = (overrides: Partial<GameInput> = {}): GameInput => ({ dx: 0, dy: 0, aim: 0, attack: false, firePressed: false, sprint: false, ...overrides });
function arena(count = 3, bots = 0): GameSim {
  const sim = new GameSim({ seed: 7, humans: Array.from({ length: count }, (_, id) => human(id)), bots });
  sim.mapObjects = []; sim.lootBoxes = [];
  sim.entities.forEach((e, i) => { e.x = 1000 + i * 200; e.y = 1000; e.z = 0; });
  sim.startGround(); sim.drainEvents();
  return sim;
}
function shoot(sim: GameSim, x = 1000, y = 1000, vx = 12000): Bullet {
  const bullet = new Bullet(sim.objectId(), x, y, 0, 0, 15);
  bullet.vx = vx; sim.bullets.push(bullet); return bullet;
}

describe('pure match simulation', () => {
  it('replays seeded worlds and event IDs independently of snapshot calls', () => {
    const a = new GameSim({ seed: 123, humans: [human(5)] });
    const b = new GameSim({ seed: 123, humans: [human(5)] });
    for (let tick = 0; tick < 250; tick++) {
      const frame = input({ seq: tick, dx: tick % 2 ? 1 : -1, sprint: tick % 3 === 0 });
      a.setInput(5, frame); b.setInput(5, frame);
      a.snapshot(); a.mapSnapshot(); a.tick(FIXED_STEP); b.tick(FIXED_STEP);
    }
    expect(a.snapshot()).toEqual(b.snapshot()); expect(a.mapSnapshot()).toEqual(b.mapSnapshot());
    expect(a.drainEvents()).toEqual(b.drainEvents());
  });
  it('normalizes participant ordering and rejects duplicate or over-capacity humans', () => {
    const a = new GameSim({ seed: 4, humans: [human(5), human(2)] });
    const b = new GameSim({ seed: 4, humans: [human(2), human(5)] });
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(() => new GameSim({ seed: 1, humans: [human(1), human(1)] })).toThrow();
    expect(() => new GameSim({ seed: 1, humans: Array.from({ length: 11 }, (_, i) => human(i)) })).toThrow();
  });
  it('fills ten slots with bots and ignores online progression advantages', () => {
    const sim = new GameSim({ seed: 1, humans: [{ ...human(0), loadout: { stage: 99, levels: [25, 25, 25, 25, 25, 25, 3] } }], stage: 99 });
    expect(sim.entities).toHaveLength(10); expect(sim.entities.filter(e => e.bot)).toHaveLength(9);
    expect(sim.entity(0)?.maxHp).toBe(400); expect(sim.entity(0)?.weapon).toBe('NONE'); expect(sim.entity(0)?.lootCount).toBe(0);
    expect(sim.entities.find(e => e.bot)?.maxHp).toBe(100); expect(sim.botAtkMult).toBe(1);
  });
  it('applies saved upgrades only in explicit practice matches', () => {
    const sim = new GameSim({ seed: 1, practice: true, humans: [{ ...human(0), loadout: { stage: 3, levels: [1, 2, 3, 0, 4, 0, 2] } }] });
    expect(sim.entity(0)?.maxHp).toBe(425); expect(sim.entity(0)?.weapon).toBe('GUN');
    expect(sim.entity(0)?.ammo).toBe(30); expect(sim.entity(0)?.lootCount).toBe(2);
    expect(sim.entities.find(e => e.bot)?.maxHp).toBe(140);
  });
  it('batches exactly three fixed steps per 50ms and ignores invalid elapsed values', () => {
    const a = arena(), b = arena();
    a.setInput(0, input({ dx: 1 })); b.setInput(0, input({ dx: 1 }));
    for (let i = 0; i < 30; i++) a.tick(FIXED_STEP);
    for (let i = 0; i < 10; i++) b.tick(0.05);
    expect(a.snapshot()).toEqual(b.snapshot()); expect(a.snapshot().tick).toBe(30);
    const before = a.snapshot(); for (const dt of [0, -1, NaN, Infinity]) a.tick(dt);
    expect(a.snapshot()).toEqual(before);
  });
  it('returns detached serializable snapshots and stable object IDs', () => {
    const sim = arena();
    sim.spawnLoot(); shoot(sim); const snap = sim.snapshot(), map = sim.mapSnapshot();
    const ids = [...map, ...snap.loot, ...snap.bullets, ...snap.craters].map(o => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    snap.entities[0].x = -100; snap.safeZone.currentR = -1;
    expect(sim.entity(0)?.x).toBe(1000); expect(sim.safeZone.currentR).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(sim.snapshot()))).toEqual(sim.snapshot());
  });
});

describe('landing and movement', () => {
  it('ignores dead airborne entities while waiting for living airborne entities', () => {
    const sim = arena(); sim.phase = 'DROPPING'; sim.time = 10;
    const dead = sim.entity(2)!; dead.alive = false; dead.hp = 0; dead.z = 100;
    sim.entity(1)!.z = 100; sim.tick(FIXED_STEP);
    expect(sim.phase).toBe('DROPPING');
    sim.entity(1)!.z = 0; sim.tick(FIXED_STEP);
    expect(sim.phase).toBe('GROUND'); expect(sim.time).toBe(60);
    sim.tick(FIXED_STEP); expect(sim.time).toBeLessThan(60);
  });
  it('uses the same base movement and collision for online prediction and authority', () => {
    const sim = arena(), actor = sim.entity(0)!;
    const wall = new MapObject(sim.objectId(), mulberry32(1));
    Object.assign(wall, { x: 1016, y: 950, width: 10, height: 100, type: 'BUILDING' }); sim.mapObjects.push(wall);
    const frame = input({ dx: 1, dy: 1, sprint: true });
    const predicted = predictMovement(sim.snapshot().entities[0], frame, sim.mapSnapshot(), FIXED_STEP);
    sim.setInput(0, frame); sim.tick(FIXED_STEP);
    expect(actor.x).toBeCloseTo(predicted.x, 10); expect(actor.y).toBeCloseTo(predicted.y, 10);
    expect(actor.x).toBe(1000); expect(actor.y).toBeGreaterThan(1000); expect(actor.stamina).toBeLessThan(100);
  });
  it('lands twice as quickly while diving and clamps movement at map bounds', () => {
    const sim = new GameSim({ seed: 3, humans: [human(0), human(1)], bots: 0 });
    sim.mapObjects = []; sim.lootBoxes = [];
    Object.assign(sim.entity(0)!, { x: 2999, y: 100 }); Object.assign(sim.entity(1)!, { x: 100, y: 2900 });
    sim.setInput(0, input({ dx: 1, sprint: true })); sim.setInput(1, input());
    for (let i = 0; i < 240; i++) sim.tick(FIXED_STEP);
    expect(sim.entity(0)!.x).toBe(CONSTANTS.MAP_SIZE);
    expect(sim.entity(0)!.z).toBeCloseTo(200, 8); expect(sim.entity(1)!.z).toBeCloseTo(600, 8);
  });
  it('lets landing impact kill a low-altitude opponent without blocking the phase', () => {
    const sim = arena(); sim.phase = 'DROPPING'; sim.time = 10;
    Object.assign(sim.entity(0)!, { x: 1000, y: 1000, z: 1 });
    Object.assign(sim.entity(1)!, { x: 1020, y: 1000, z: 20 });
    sim.tick(FIXED_STEP);
    expect(sim.entity(1)!.alive).toBe(false); expect(sim.entity(0)!.kills).toBe(1);
    sim.tick(FIXED_STEP); expect(sim.phase).toBe('GROUND');
  });
});

describe('weapons and swept projectiles', () => {
  it('finds crossings whose endpoints both lie outside a target', () => {
    expect(segmentCircle(0, 0, 100, 0, 50, 0, 15)).toBeCloseTo(0.35);
    expect(segmentCircle(0, 0, 100, 0, 50, 16, 15)).toBeNull();
  });
  it('hits only the nearest target once, even when a fast projectile crosses two', () => {
    const sim = arena(); sim.entity(1)!.x = 1080; sim.entity(2)!.x = 1130;
    shoot(sim); sim.tick(FIXED_STEP);
    expect(sim.entity(1)!.hp).toBe(385); expect(sim.entity(2)!.hp).toBe(400); expect(sim.bullets).toHaveLength(0);
  });
  it('resolves overlapping targets in stable ID order without multi-hit damage', () => {
    const sim = arena(); sim.entity(1)!.x = 1030; sim.entity(2)!.x = 1030;
    shoot(sim); sim.tick(FIXED_STEP);
    expect(sim.entity(1)!.hp).toBe(385); expect(sim.entity(2)!.hp).toBe(400);
  });
  it('blocks targets behind the first wall and still hits a target in front of it', () => {
    const sim = arena(); sim.entity(1)!.x = 1080;
    const wall = new MapObject(sim.objectId(), mulberry32(1));
    Object.assign(wall, { type: 'BUILDING', x: 1040, y: 900, width: 10, height: 200 }); sim.mapObjects.push(wall);
    shoot(sim); sim.tick(FIXED_STEP); expect(sim.entity(1)!.hp).toBe(400); expect(sim.bullets).toHaveLength(0);
    wall.x = 1120; shoot(sim); sim.tick(FIXED_STEP); expect(sim.entity(1)!.hp).toBe(385);
  });
  it('sweeps circular rocks and grazing character hits', () => {
    const sim = arena(); Object.assign(sim.entity(1)!, { x: 1010, y: 1014.9 });
    shoot(sim, 1000, 1000, 1200); sim.tick(FIXED_STEP); expect(sim.entity(1)!.hp).toBe(385);
    Object.assign(sim.entity(1)!, { x: 1080, y: 1000 });
    const rock = new MapObject(sim.objectId(), mulberry32(1)); Object.assign(rock, { type: 'ROCK', x: 1040, y: 1000, width: 10, height: 10 }); sim.mapObjects.push(rock);
    shoot(sim); sim.tick(FIXED_STEP); expect(sim.entity(1)!.hp).toBe(385);
  });
  it('coalesces a short click until a step and rejects duplicate input sequences', () => {
    const sim = arena(), shooter = sim.entity(0)!; shooter.equipWeapon('GUN');
    sim.setInput(0, input({ seq: 1, firePressed: true })); sim.setInput(0, input({ seq: 2 }));
    sim.tick(0.05); expect(shooter.ammo).toBe(29);
    sim.tick(0.5); sim.setInput(0, input({ seq: 2, firePressed: true })); sim.tick(FIXED_STEP);
    expect(shooter.ammo).toBe(29);
  });
  it('applies shields, ammunition, cooldown and kill credit authoritatively', () => {
    const sim = arena(), shooter = sim.entity(0)!, target = sim.entity(1)!;
    target.x = 1030; target.weapon = 'SHIELD'; shooter.equipWeapon('GUN');
    sim.setInput(0, input({ attack: true })); sim.tick(FIXED_STEP);
    expect(target.hp).toBe(392.5); expect(shooter.ammo).toBe(29);
    sim.tick(FIXED_STEP); expect(shooter.ammo).toBe(29);
    target.hp = 1; sim.tick(0.2);
    expect(target.alive).toBe(false); expect(shooter.kills).toBe(1); expect(sim.ended).toBe(false);
    const events = sim.drainEvents(); expect(new Set(events.map(e => e.id)).size).toBe(events.length);
    expect(events.filter(e => e.type === 'kill' && e.targetId === 1)).toHaveLength(1);
  });
  it('allows humans to compete for one loot box exactly once', () => {
    const sim = arena(); sim.entity(1)!.x = sim.entity(0)!.x;
    sim.lootBoxes.push(new LootBox(sim.objectId(), 1000, 1000, 'GUN')); sim.tick(FIXED_STEP);
    expect(sim.entity(0)!.lootCount).toBe(1); expect(sim.entity(1)!.lootCount).toBe(0);
    expect(sim.snapshot().loot).toHaveLength(0);
  });
});

describe('per-player and room outcomes', () => {
  it('continues after one human dies and closes when every human is dead', () => {
    const sim = arena(3, 1); sim.entity(0)!.takeDamage(1000, null);
    expect(sim.ended).toBe(false); sim.tick(FIXED_STEP); expect(sim.time).toBeLessThan(60);
    sim.entity(1)!.takeDamage(1000, null); sim.entity(2)!.takeDamage(1000, null);
    expect(sim.result).toEqual({ reason: 'all_humans_dead', winnerId: null, outcomes: { 0: 'death', 1: 'death', 2: 'death' } });
  });
  it('awards the last living entity without reviving defeated players', () => {
    const sim = arena(); sim.entity(1)!.takeDamage(1000, sim.entity(0)!); sim.entity(2)!.takeDamage(1000, sim.entity(0)!);
    expect(sim.result).toEqual({ reason: 'last', winnerId: 0, outcomes: { 0: 'win', 1: 'death', 2: 'death' } });
  });
  it('lets any human with seven crates win at the portal and freezes on END', () => {
    const sim = arena(); sim.hasFirstLanded = true; sim.entity(1)!.lootCount = 7;
    Object.assign(sim.portal, { active: true, x: 1200, y: 1000, timer: 10 }); sim.tick(FIXED_STEP);
    expect(sim.result).toEqual({ reason: 'portal', winnerId: 1, outcomes: { 0: 'defeated', 1: 'win', 2: 'defeated' } });
    const before = sim.snapshot(); sim.tick(10); sim.disconnect(1); sim.interrupt(); expect(sim.snapshot()).toEqual(before);
  });
  it('rejects bots, airborne humans and insufficient loot as portal winners', () => {
    const sim = new GameSim({ seed: 1, humans: [human(0), human(1)], bots: 1 });
    sim.mapObjects = []; sim.lootBoxes = []; sim.hasFirstLanded = true; sim.startGround();
    Object.assign(sim.portal, { active: true, x: 1000, y: 1000, timer: 10 });
    Object.assign(sim.entity(0)!, { x: 1000, y: 1000, z: 100, lootCount: 7 });
    Object.assign(sim.entity(1)!, { x: 1000, y: 1000, z: 0, lootCount: 6 });
    Object.assign(sim.entities.find(e => e.bot)!, { x: 1000, y: 1000, z: 0, lootCount: 7 });
    sim.tick(FIXED_STEP); expect(sim.ended).toBe(false);
  });
  it('treats every living human as survived at time limit with no arbitrary winner', () => {
    const sim = arena(); sim.entity(1)!.takeDamage(1000, null); sim.time = FIXED_STEP; sim.tick(0.05);
    expect(sim.result).toEqual({ reason: 'time', winnerId: null, outcomes: { 0: 'survived', 1: 'death', 2: 'survived' } });
    expect(sim.snapshot().tick).toBe(1);
  });
  it('preserves left and death outcomes when a match is interrupted', () => {
    const sim = arena(4); sim.disconnect(0); sim.entity(1)!.takeDamage(1000, null);
    // Leaving after a death must not change an already earned death outcome to left.
    sim.disconnect(1); sim.interrupt();
    expect(sim.result).toEqual({ reason: 'interrupted', winnerId: null, outcomes: { 0: 'left', 1: 'death', 2: 'interrupted', 3: 'interrupted' } });
  });
});
