import { FIXED_STEP } from './protocol';
import type { ActorState, GameEvent, GameInput, Loadout, MapProp, MatchOptions, MatchResult, Outcome, Phase, Snapshot, Weapon } from './protocol';

export const CONSTANTS = {
  MAP_SIZE: 3000, START_ALTITUDE: 1000, DROP_TIME_NORMAL: 10, DROP_TIME_FAST: 5, GROUND_TIME: 60,
  PLAYER_SPEED_AIR: 300, PLAYER_SPEED_GROUND: 200, PLAYER_RADIUS: 15, CRATER_RADIUS: 60,
  LOOT_SPAWN_INTERVAL: 5, BLUEZONE_DAMAGE: 90, WIN_LOOT_COUNT: 7, PORTAL_SPAWN_TIME: 20,
  PORTAL_DURATION: 10, SLOTS: 10, MAP_OBJECT_COUNT: 60, INITIAL_LOOT: 30,
} as const;

interface WeaponDefinition { name: string; range: number; damage: number; delay: number; speed?: number; defense?: number }
export const WEAPONS: Record<Weapon, WeaponDefinition> = {
  NONE: { name: '맨손', range: 40, damage: 5, delay: 500 },
  KNIFE: { name: '나이프', range: 60, damage: 40, delay: 400 },
  GUN: { name: '소총', range: 500, damage: 15, delay: 150, speed: 1200 },
  SHIELD: { name: '방탄방패', range: 40, damage: 10, delay: 600, defense: 0.5 },
};

export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const finite = (n: number | undefined, fallback = 0) => Number.isFinite(n) ? n! : fallback;
const neutral = (): GameInput => ({ dx: 0, dy: 0, aim: 0, attack: false, firePressed: false, sprint: false });
type Input = Omit<GameInput, 'firePressed'> & { firePressed?: boolean };
interface Stats { hpBonus: number; atkMult: number; spdMult: number; staDrain: number; staRecover: number; luck: number; gear: number }
const baseStats = (): Stats => ({ hpBonus: 0, atkMult: 1, spdMult: 1, staDrain: 1, staRecover: 1, luck: 0, gear: 0 });
function practiceStats(loadout?: Loadout): Stats {
  const lv = (i: number) => clamp(Math.floor(finite(loadout?.levels[i])), 0, i === 6 ? 3 : 25);
  return { hpBonus: lv(0) * 25, atkMult: 1 + lv(1) * 0.08, spdMult: 1 + lv(2) * 0.06,
    staDrain: Math.max(0.4, 1 - lv(3) * 0.05), staRecover: 1 + lv(3) * 0.06, luck: lv(4), gear: lv(6) };
}

export function mapCollision(prop: MapProp, x: number, y: number, radius: number): boolean {
  if (prop.type === 'ROCK') return Math.hypot(x - prop.x, y - prop.y) < prop.width / 2 + radius;
  const nx = clamp(x, prop.x, prop.x + prop.width), ny = clamp(y, prop.y, prop.y + prop.height);
  return (x - nx) ** 2 + (y - ny) ** 2 < radius ** 2;
}

function movement(actor: ActorState, input: Input, map: MapProp[], dt: number, multiplier: number): { x: number; y: number } {
  if (!actor.alive) return { x: actor.x, y: actor.y };
  const dx = clamp(finite(input.dx), -1, 1), dy = clamp(finite(input.dy), -1, 1);
  const length = Math.hypot(dx, dy);
  if (!length) return { x: actor.x, y: actor.y };
  const airborne = actor.z > 0;
  let speed = (airborne ? CONSTANTS.PLAYER_SPEED_AIR : CONSTANTS.PLAYER_SPEED_GROUND) * multiplier;
  if (!airborne && input.sprint && !actor.fatigued && actor.stamina > 0) speed *= 1.5;
  const nx = actor.x + dx / length * speed * dt, ny = actor.y + dy / length * speed * dt;
  const collides = (x: number, y: number) => map.some(p => mapCollision(p, x, y, CONSTANTS.PLAYER_RADIUS));
  let x = actor.x, y = actor.y;
  if (airborne || !collides(nx, ny)) { x = nx; y = ny; }
  else if (!collides(nx, y)) x = nx;
  else if (!collides(x, ny)) y = ny;
  return { x: clamp(x, 0, CONSTANTS.MAP_SIZE), y: clamp(y, 0, CONSTANTS.MAP_SIZE) };
}

/** The online client's movement prediction uses the same collision and speed rules as authority. */
export function predictMovement(actor: ActorState, input: GameInput, map: MapProp[], dt: number): { x: number; y: number } {
  return movement(actor, input, map, Math.max(0, finite(dt)), 1);
}

export class MapObject implements MapProp {
  x: number; y: number; width: number; height: number; type: MapProp['type'];
  constructor(public id: number, rand: () => number) {
    this.x = rand() * CONSTANTS.MAP_SIZE; this.y = rand() * CONSTANTS.MAP_SIZE;
    this.type = rand() > 0.4 ? 'BUILDING' : 'ROCK'; this.width = 60 + rand() * 120;
    this.height = this.type === 'BUILDING' ? 60 + rand() * 100 : this.width;
  }
  checkCollision(x: number, y: number, radius: number): boolean { return mapCollision(this, x, y, radius); }
}

export class Bullet {
  vx: number; vy: number; life = 1;
  constructor(public id: number, public x: number, public y: number, public angle: number, public ownerId: number, public damage: number) {
    this.vx = Math.cos(angle) * (WEAPONS.GUN.speed ?? 1200);
    this.vy = Math.sin(angle) * (WEAPONS.GUN.speed ?? 1200);
  }
}
export class LootBox {
  active = true;
  constructor(public id: number, public x: number, public y: number, public type: Weapon) {}
}

/** Return the first fraction along the segment intersecting a circle, including a start inside it. */
export function segmentCircle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, radius: number): number | null {
  const ox = ax - cx, oy = ay - cy, dx = bx - ax, dy = by - ay;
  const c = ox * ox + oy * oy - radius * radius;
  if (c <= 0) return 0;
  const a = dx * dx + dy * dy;
  if (a === 0) return null;
  const b = 2 * (ox * dx + oy * dy), discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const t = (-b - Math.sqrt(discriminant)) / (2 * a);
  return t >= 0 && t <= 1 ? t : null;
}

function segmentBox(ax: number, ay: number, bx: number, by: number, prop: MapProp): number | null {
  let enter = 0, exit = 1;
  const axes = [[ax, bx - ax, prop.x - 2, prop.x + prop.width + 2], [ay, by - ay, prop.y - 2, prop.y + prop.height + 2]];
  for (const [start, delta, lo, hi] of axes) {
    if (delta === 0) { if (start < lo || start > hi) return null; continue; }
    const a = (lo - start) / delta, b = (hi - start) / delta;
    enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b));
    if (enter > exit) return null;
  }
  return enter >= 0 && enter <= 1 ? enter : null;
}

export class Entity implements ActorState {
  x = 0; y = 0; z: number = CONSTANTS.START_ALTITUDE; angle = 0; radius: number = CONSTANTS.PLAYER_RADIUS;
  maxHp: number; hp: number; stamina = 100; fatigued = false; alive = true;
  weapon: Weapon = 'NONE'; kills = 0; ammo = 0; lootCount = 0; isDiving = false;
  dropSpeed = CONSTANTS.START_ALTITUDE / CONSTANTS.DROP_TIME_NORMAL;
  actionTimer = 0; attackCooldown = 0; lastX = 0; lastY = 0; stuckCounter = 0;
  constructor(public world: GameSim, public id: number, public bot: boolean, public nick: string, public color: string, public loadout: Stats = baseStats()) {
    this.maxHp = bot ? 100 * world.botHpMult : 400 + loadout.hpBonus; this.hp = this.maxHp;
    if (!bot) {
      this.lootCount = Math.floor(loadout.luck / 4);
      if (loadout.gear >= 1) this.equipWeapon(loadout.gear >= 2 ? 'GUN' : 'KNIFE', true);
      if (loadout.gear >= 3) this.ammo = 45;
    }
  }
  update(dt: number, input: Input): void {
    if (!this.alive || this.world.ended) return;
    if (this.z > 0) this.updateDrop(dt, input); else this.updateGround(dt, input);
  }
  updateDrop(dt: number, input: Input): void {
    if (this.bot) {
      if (this.actionTimer <= 0) { this.isDiving = this.world.rand() > 0.5; this.actionTimer = this.world.rand() * 2; }
      else this.actionTimer -= dt;
    } else this.isDiving = !!input.sprint;
    const rate = this.isDiving ? CONSTANTS.START_ALTITUDE / CONSTANTS.DROP_TIME_FAST : this.dropSpeed;
    // Use the airborne movement rules before changing altitude for this step.
    if (this.bot) {
      const dx = this.world.rand() - 0.5, dy = this.world.rand() - 0.5;
      const len = Math.hypot(dx, dy) || 1;
      this.x += dx / len * CONSTANTS.PLAYER_SPEED_AIR * dt; this.y += dy / len * CONSTANTS.PLAYER_SPEED_AIR * dt;
    } else Object.assign(this, movement(this, input, this.world.mapObjects, dt, this.loadout.spdMult));
    this.z = Math.max(0, this.z - rate * dt); this.clampPosition();
    if (this.z <= 0) { this.isDiving = false; this.world.land(this); }
    if (this.world.ended) return;
    for (const other of this.world.entities) {
      if (other === this || !other.alive || other.z <= 0 || Math.abs(this.z - other.z) > 100) continue;
      if (Math.hypot(this.x - other.x, this.y - other.y) < this.radius * 2) {
        const angle = Math.atan2(this.y - other.y, this.x - other.x);
        this.x += Math.cos(angle) * 10; this.y += Math.sin(angle) * 10; this.isDiving = false;
      }
    }
    this.clampPosition();
  }
  updateGround(dt: number, input: Input): void {
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    if (this.world.phase === 'GROUND') {
      const zone = this.world.safeZone;
      if (Math.hypot(this.x - zone.currentX, this.y - zone.currentY) > zone.currentR) this.takeDamage(CONSTANTS.BLUEZONE_DAMAGE * dt, null);
    }
    if (!this.alive || this.world.ended) return;
    if (this.bot) this.updateAI(dt); else this.updateHuman(dt, input);
    if (this.world.ended) return;
    this.clampPosition();
    for (const box of this.world.lootBoxes) {
      if (!box.active || Math.hypot(this.x - box.x, this.y - box.y) >= this.radius + 15) continue;
      const type = this.bot ? box.type : this.world.rollLoot(this.loadout.luck);
      this.equipWeapon(type); box.active = false;
      this.world.emit('loot', box.x, box.y, { actorId: this.id, value: this.lootCount });
    }
  }
  updateHuman(dt: number, input: Input): void {
    Object.assign(this, movement(this, input, this.world.mapObjects, dt, this.loadout.spdMult));
    const moving = input.dx !== 0 || input.dy !== 0;
    if (this.fatigued) {
      this.stamina = Math.min(100, this.stamina + 33.3 * this.loadout.staRecover * dt);
      if (this.stamina >= 100) this.fatigued = false;
    } else if (input.sprint && moving && this.stamina > 0) {
      this.stamina = Math.max(0, this.stamina - 40 * this.loadout.staDrain * dt);
      if (this.stamina <= 0) this.fatigued = true;
    } else this.stamina = Math.min(100, this.stamina + 20 * this.loadout.staRecover * dt);
    this.angle = finite(input.aim, this.angle);
    if ((input.attack || input.firePressed) && this.attackCooldown <= 0) this.attack();
  }
  updateAI(dt: number): void {
    this.actionTimer -= dt;
    if (Math.hypot(this.x - this.lastX, this.y - this.lastY) < 1) this.stuckCounter += dt; else this.stuckCounter = 0;
    this.lastX = this.x; this.lastY = this.y;
    if (this.stuckCounter > 0.5) {
      if (this.stuckCounter > 2) this.stuckCounter = 0;
      const angle = this.world.rand() * Math.PI * 2;
      this.x += Math.cos(angle) * 50; this.y += Math.sin(angle) * 50; return;
    }
    const zone = this.world.safeZone;
    if (this.world.phase === 'GROUND' && Math.hypot(this.x - zone.currentX, this.y - zone.currentY) > zone.currentR - 100) {
      this.moveAI(zone.currentX, zone.currentY, dt); this.findAndAttackEnemy(dt, true); return;
    }
    if (this.weapon === 'NONE' || (this.weapon === 'GUN' && this.ammo <= 0)) {
      let target: LootBox | undefined, distance = Infinity;
      for (const box of this.world.lootBoxes) {
        const d = Math.hypot(this.x - box.x, this.y - box.y);
        if (box.active && d < distance) { target = box; distance = d; }
      }
      if (target) { this.moveAI(target.x, target.y, dt); this.angle = Math.atan2(target.y - this.y, target.x - this.x); return; }
    }
    this.findAndAttackEnemy(dt, false);
  }
  findAndAttackEnemy(dt: number, onlyAttack: boolean): void {
    let target: Entity | undefined, distance = Infinity;
    for (const entity of this.world.entities) {
      if (entity === this || !entity.alive) continue;
      const d = Math.hypot(this.x - entity.x, this.y - entity.y);
      if (d < distance) { target = entity; distance = d; }
    }
    if (!target) return;
    this.angle = Math.atan2(target.y - this.y, target.x - this.x);
    const range = WEAPONS[this.weapon].range;
    if (!onlyAttack) {
      if (distance > (this.weapon === 'GUN' ? 250 : range * 0.8)) this.moveAI(target.x, target.y, dt);
      else if (this.weapon === 'GUN' && distance < 100) {
        const speed = CONSTANTS.PLAYER_SPEED_GROUND * this.world.botSpdMult;
        const nx = this.x - Math.cos(this.angle) * speed * dt, ny = this.y - Math.sin(this.angle) * speed * dt;
        if (!this.checkMapCollision(nx, ny)) { this.x = nx; this.y = ny; }
      }
    }
    if ((distance <= range || (this.weapon === 'GUN' && distance < 600)) && this.attackCooldown <= 0) this.attack();
  }
  moveAI(tx: number, ty: number, dt: number): void {
    const angle = Math.atan2(ty - this.y, tx - this.x), speed = CONSTANTS.PLAYER_SPEED_GROUND * this.world.botSpdMult;
    for (const offset of [0, 0.5, -0.5, 1, -1, 1.5, -1.5]) {
      const nx = this.x + Math.cos(angle + offset) * speed * dt, ny = this.y + Math.sin(angle + offset) * speed * dt;
      if (!this.world.mapObjects.some(p => mapCollision(p, nx, ny, this.radius + 5))) { this.x = nx; this.y = ny; return; }
    }
  }
  checkMapCollision(x: number, y: number): boolean { return this.world.mapObjects.some(p => mapCollision(p, x, y, this.radius)); }
  clampPosition(): void { this.x = clamp(this.x, 0, CONSTANTS.MAP_SIZE); this.y = clamp(this.y, 0, CONSTANTS.MAP_SIZE); }
  equipWeapon(type: Weapon, silent = false): void {
    this.lootCount++; this.weapon = type; this.ammo = type === 'GUN' ? 30 : 0;
    if (!silent) this.world.emit('equip', this.x, this.y, { actorId: this.id, value: this.lootCount });
  }
  attack(): void {
    if (!this.alive || this.world.ended || this.z > 0) return;
    const weapon = WEAPONS[this.weapon]; this.attackCooldown = weapon.delay / 1000;
    const damage = weapon.damage * (this.bot ? this.world.botAtkMult : this.loadout.atkMult);
    if (this.weapon === 'GUN') {
      if (this.ammo > 0) {
        this.ammo--; this.world.bullets.push(new Bullet(this.world.objectId(), this.x, this.y, this.angle, this.id, damage));
        this.world.emit('shot', this.x, this.y, { actorId: this.id });
      }
      return;
    }
    for (const target of this.world.entities) {
      if (this.world.ended) break;
      if (target === this || !target.alive || Math.hypot(target.x - this.x, target.y - this.y) >= weapon.range) continue;
      const diff = Math.abs(Math.atan2(target.y - this.y, target.x - this.x) - this.angle);
      if (diff < 1.5 || diff > 4.7) target.takeDamage(damage, this);
    }
  }
  takeDamage(amount: number, attacker: Entity | null): void {
    if (!this.alive || this.world.ended || !Number.isFinite(amount) || amount <= 0) return;
    if (this.weapon === 'SHIELD') amount *= WEAPONS.SHIELD.defense ?? 0.5;
    this.hp = Math.max(0, this.hp - amount);
    this.world.emit('hit', this.x, this.y, { actorId: attacker?.id, targetId: this.id, value: amount });
    if (this.hp > 0) return;
    this.alive = false; this.isDiving = false;
    if (attacker && attacker !== this) attacker.kills++;
    this.world.emit('kill', this.x, this.y, { actorId: attacker?.id, targetId: this.id, color: this.color });
    this.world.checkWin();
  }
}

export class GameSim {
  readonly seed: number; readonly rand: () => number;
  phase: Phase = 'DROPPING'; time: number = CONSTANTS.DROP_TIME_NORMAL; ended = false; result: MatchResult | null = null;
  entities: Entity[] = []; mapObjects: MapObject[] = []; bullets: Bullet[] = []; lootBoxes: LootBox[] = [];
  craters: Snapshot['craters'] = [];
  portal = { active: false, x: 0, y: 0, radius: 60, timer: 0, spawnTimer: Number(CONSTANTS.PORTAL_SPAWN_TIME) };
  safeZone = { currentX: 0, currentY: 0, currentR: 0, startX: 0, startY: 0, endX: 0, endY: 0, startR: 0, endR: 200 };
  botHpMult = 1; botAtkMult = 1; botSpdMult = 1; hasFirstLanded = false; tickCount = 0;
  private lootSpawnTimer: number = CONSTANTS.LOOT_SPAWN_INTERVAL;
  private accumulator = 0; private nextObjectId = 1; private nextEventId = 1;
  private events: GameEvent[] = []; private inputs = new Map<number, GameInput>();
  private inputSeq = new Map<number, number>(); private pendingFire = new Set<number>(); private left = new Set<number>();

  constructor(options: MatchOptions) {
    if (options.humans.length > CONSTANTS.SLOTS) throw new Error('A match has at most ten human slots');
    const ids = options.humans.map(h => h.id);
    if (new Set(ids).size !== ids.length || ids.some(id => !Number.isSafeInteger(id) || id < 0)) throw new Error('Human IDs must be unique non-negative integers');
    this.seed = finite(options.seed) >>> 0; this.rand = mulberry32(this.seed);
    if (options.practice) {
      const stage = clamp(Math.floor(finite(options.stage ?? options.humans[0]?.loadout?.stage, 1)), 1, 99);
      this.botHpMult = 1 + (stage - 1) * 0.2; this.botAtkMult = 1 + (stage - 1) * 0.12;
      this.botSpdMult = Math.min(1.6, 1 + (stage - 1) * 0.04);
    }
    for (let i = 0; i < CONSTANTS.MAP_OBJECT_COUNT; i++) this.mapObjects.push(new MapObject(this.objectId(), this.rand));
    for (const human of [...options.humans].sort((a, b) => a.id - b.id)) {
      const entity = new Entity(this, human.id, false, human.nick.slice(0, 12) || 'PLAYER', /^#[0-9a-f]{6}$/i.test(human.color) ? human.color : '#00BFFF', options.practice ? practiceStats(human.loadout) : baseStats());
      Object.assign(entity, this.safeSpawn()); this.entities.push(entity);
    }
    let nextId = Math.max(-1, ...ids) + 1;
    const count = clamp(Math.floor(finite(options.bots, CONSTANTS.SLOTS - ids.length)), 0, CONSTANTS.SLOTS - ids.length);
    for (let i = 0; i < count; i++) {
      const entity = new Entity(this, nextId++, true, `BOT ${i + 1}`, '#FF5252');
      Object.assign(entity, this.safeSpawn()); this.entities.push(entity);
    }
    for (let i = 0; i < CONSTANTS.INITIAL_LOOT; i++) this.spawnLoot();
  }
  objectId(): number { return this.nextObjectId++; }
  entity(id: number): Entity | undefined { return this.entities.find(e => e.id === id); }
  emit(type: string, x = 0, y = 0, extra: Omit<Partial<GameEvent>, 'id' | 'type' | 'x' | 'y'> = {}): void {
    this.events.push({ id: this.nextEventId++, type, x, y, ...extra });
  }
  drainEvents(): GameEvent[] { const events = this.events; this.events = []; return events; }
  setInput(id: number, raw: Input): void {
    const entity = this.entity(id);
    if (this.ended || !entity?.alive || entity.bot) return;
    if (raw.seq !== undefined) {
      if (!Number.isSafeInteger(raw.seq) || raw.seq <= (this.inputSeq.get(id) ?? -1)) return;
      this.inputSeq.set(id, raw.seq);
    }
    this.inputs.set(id, { seq: raw.seq, dx: clamp(finite(raw.dx), -1, 1), dy: clamp(finite(raw.dy), -1, 1), aim: finite(raw.aim),
      attack: !!raw.attack, sprint: !!raw.sprint, firePressed: false });
    if (raw.firePressed) this.pendingFire.add(id);
  }
  safeSpawn(): { x: number; y: number } {
    for (let i = 0; i < 50; i++) {
      const x = this.rand() * (CONSTANTS.MAP_SIZE - 100) + 50, y = this.rand() * (CONSTANTS.MAP_SIZE - 100) + 50;
      if (!this.mapObjects.some(p => mapCollision(p, x, y, CONSTANTS.PLAYER_RADIUS + 5))) return { x, y };
    }
    return { x: CONSTANTS.MAP_SIZE / 2, y: CONSTANTS.MAP_SIZE / 2 };
  }
  rollLoot(luck: number): Weapon {
    const gun = 0.60 + luck * 0.03, knife = 0.20 + luck * 0.02, shield = Math.max(0.05, 1 - gun - knife);
    const r = this.rand() * (gun + knife + shield);
    return r < gun ? 'GUN' : r < gun + knife ? 'KNIFE' : 'SHIELD';
  }
  spawnLoot(): void {
    for (let i = 0; i < 10; i++) {
      const x = this.rand() * (CONSTANTS.MAP_SIZE - 100) + 50, y = this.rand() * (CONSTANTS.MAP_SIZE - 100) + 50;
      if (this.mapObjects.some(p => mapCollision(p, x, y, 15))) continue;
      const r = this.rand(), type = r < 0.6 ? 'GUN' : r < 0.8 ? 'SHIELD' : 'KNIFE';
      this.lootBoxes.push(new LootBox(this.objectId(), x, y, type)); return;
    }
  }
  land(entity: Entity): void {
    this.craters.push({ id: this.objectId(), x: entity.x, y: entity.y, radius: CONSTANTS.CRATER_RADIUS, alpha: 1 });
    this.emit('land', entity.x, entity.y, { actorId: entity.id });
    if (!this.hasFirstLanded) { this.hasFirstLanded = true; this.emit('first_land', entity.x, entity.y, { actorId: entity.id }); }
    for (const target of this.entities) {
      if (this.ended) break;
      if (target !== entity && target.alive && target.z <= 50 && Math.hypot(target.x - entity.x, target.y - entity.y) < CONSTANTS.CRATER_RADIUS) target.takeDamage(1000, entity);
    }
  }
  startGround(): void {
    if (this.ended) return;
    this.phase = 'GROUND'; this.time = CONSTANTS.GROUND_TIME;
    const end = this.safeSpawn();
    Object.assign(this.safeZone, { startX: 1500, startY: 1500, currentX: 1500, currentY: 1500, endX: end.x, endY: end.y, startR: CONSTANTS.MAP_SIZE * 0.8, currentR: CONSTANTS.MAP_SIZE * 0.8 });
    this.emit('ground');
  }
  checkWin(): void {
    if (this.ended) return;
    const humans = this.entities.filter(e => !e.bot), alive = this.entities.filter(e => e.alive);
    if (humans.length && humans.every(e => !e.alive)) this.finish('all_humans_dead', null);
    else if (alive.length <= 1) this.finish('last', alive[0] ?? null);
  }
  private finish(reason: MatchResult['reason'], winner: Entity | null): void {
    if (this.ended) return;
    const outcomes: Record<string, Outcome> = {};
    for (const human of this.entities.filter(e => !e.bot)) {
      outcomes[String(human.id)] = this.left.has(human.id) ? 'left' : !human.alive ? 'death' : reason === 'interrupted' ? 'interrupted' : winner?.id === human.id ? 'win' : reason === 'time' ? 'survived' : 'defeated';
    }
    this.ended = true; this.phase = 'END'; this.result = { reason, winnerId: winner?.id ?? null, outcomes };
    this.emit('match_end', winner?.x ?? 0, winner?.y ?? 0, { actorId: winner?.id });
  }
  disconnect(id: number): void {
    const entity = this.entity(id);
    if (!entity || entity.bot || this.ended) return;
    this.inputs.delete(id); this.pendingFire.delete(id);
    if (entity.alive) { this.left.add(id); entity.takeDamage(1e9, null); }
  }
  interrupt(): void { this.finish('interrupted', null); }
  tick(dt: number): void {
    if (this.ended || !Number.isFinite(dt) || dt <= 0) return;
    this.accumulator += dt;
    while (this.accumulator + 1e-9 >= FIXED_STEP && !this.ended) {
      this.accumulator = Math.max(0, this.accumulator - FIXED_STEP); this.step();
    }
  }
  private step(): void {
    this.tickCount++;
    if (this.hasFirstLanded) {
      this.lootSpawnTimer -= FIXED_STEP;
      if (this.lootSpawnTimer <= 0) { this.spawnLoot(); this.lootSpawnTimer += CONSTANTS.LOOT_SPAWN_INTERVAL; }
      if (!this.portal.active) {
        this.portal.spawnTimer -= FIXED_STEP;
        if (this.portal.spawnTimer <= 0) {
          Object.assign(this.portal, this.safeSpawn(), { active: true, timer: CONSTANTS.PORTAL_DURATION, spawnTimer: CONSTANTS.PORTAL_SPAWN_TIME + this.rand() * 20 });
          this.emit('portal_spawn', this.portal.x, this.portal.y);
        }
      } else {
        for (const human of this.entities) {
          if (human.bot || !human.alive || human.z > 0 || human.lootCount < CONSTANTS.WIN_LOOT_COUNT) continue;
          if (Math.hypot(human.x - this.portal.x, human.y - this.portal.y) < this.portal.radius) { this.finish('portal', human); return; }
        }
        this.portal.timer = Math.max(0, this.portal.timer - FIXED_STEP);
        if (this.portal.timer <= 0) { this.portal.active = false; this.emit('portal_gone', this.portal.x, this.portal.y); }
      }
    }
    if (this.phase === 'DROPPING') {
      if (this.entities.every(e => !e.alive || e.z <= 0)) this.startGround();
    } else if (this.phase === 'GROUND') {
      this.time = Math.max(0, this.time - FIXED_STEP);
      if (this.time <= 1e-9) { this.time = 0; this.finish('time', null); return; }
      const p = 1 - this.time / CONSTANTS.GROUND_TIME, zone = this.safeZone;
      zone.currentR = zone.startR + (zone.endR - zone.startR) * p;
      zone.currentX = zone.startX + (zone.endX - zone.startX) * p; zone.currentY = zone.startY + (zone.endY - zone.startY) * p;
    }
    for (const entity of this.entities) {
      if (this.ended) return;
      const input = { ...(this.inputs.get(entity.id) ?? neutral()), firePressed: this.pendingFire.delete(entity.id) };
      entity.update(FIXED_STEP, input);
    }
    if (this.ended) return;
    this.moveBullets(FIXED_STEP); this.checkWin();
  }
  private moveBullets(dt: number): void {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      if (this.ended) return;
      const bullet = this.bullets[i], fraction = Math.min(dt, bullet.life);
      const nx = bullet.x + bullet.vx * fraction, ny = bullet.y + bullet.vy * fraction;
      let hitFraction = Infinity, target: Entity | null = null;
      for (const prop of this.mapObjects) {
        const t = prop.type === 'ROCK' ? segmentCircle(bullet.x, bullet.y, nx, ny, prop.x, prop.y, prop.width / 2 + 2) : segmentBox(bullet.x, bullet.y, nx, ny, prop);
        if (t !== null && t < hitFraction) { hitFraction = t; target = null; }
      }
      for (const entity of this.entities) {
        if (!entity.alive || entity.id === bullet.ownerId) continue;
        const t = segmentCircle(bullet.x, bullet.y, nx, ny, entity.x, entity.y, entity.radius + (entity.z > 0 ? 10 : 0));
        if (t !== null && t < hitFraction) { hitFraction = t; target = entity; }
      }
      const hit = Number.isFinite(hitFraction);
      if (hit) {
        bullet.x += (nx - bullet.x) * hitFraction; bullet.y += (ny - bullet.y) * hitFraction;
        if (target) target.takeDamage(bullet.damage, this.entity(bullet.ownerId) ?? null);
        else this.emit('wall_hit', bullet.x, bullet.y, { actorId: bullet.ownerId });
      } else { bullet.x = nx; bullet.y = ny; }
      bullet.life -= dt;
      if (hit || bullet.life <= 0 || bullet.x < 0 || bullet.y < 0 || bullet.x > CONSTANTS.MAP_SIZE || bullet.y > CONSTANTS.MAP_SIZE) this.bullets.splice(i, 1);
    }
  }
  snapshot(): Snapshot {
    return { tick: this.tickCount, phase: this.phase, time: this.time, ended: this.ended,
      result: this.result ? { ...this.result, outcomes: { ...this.result.outcomes } } : null,
      entities: this.entities.map(e => ({ id: e.id, bot: e.bot, x: e.x, y: e.y, z: e.z, angle: e.angle, hp: e.hp, maxHp: e.maxHp,
        stamina: e.stamina, fatigued: e.fatigued, alive: e.alive, weapon: e.weapon, ammo: e.ammo, kills: e.kills, lootCount: e.lootCount, isDiving: e.isDiving })),
      bullets: this.bullets.map(b => ({ id: b.id, x: b.x, y: b.y, angle: b.angle })),
      loot: this.lootBoxes.filter(b => b.active).map(b => ({ id: b.id, x: b.x, y: b.y, type: b.type })),
      craters: this.craters.map(c => ({ ...c })), safeZone: { currentX: this.safeZone.currentX, currentY: this.safeZone.currentY, currentR: this.safeZone.currentR },
      portal: { active: this.portal.active, x: this.portal.x, y: this.portal.y, radius: this.portal.radius, timer: this.portal.timer } };
  }
  mapSnapshot(): MapProp[] { return this.mapObjects.map(p => ({ id: p.id, x: p.x, y: p.y, width: p.width, height: p.height, type: p.type })); }
}
