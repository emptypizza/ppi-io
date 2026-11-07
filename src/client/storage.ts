export const SAVE_KEY = 'ppi_io_save_v1';
export const SKINS = [
  { id: 'classic', name: '클래식', color: '#00BFFF', stage: 1 },
  { id: 'lime', name: '라임', color: '#76FF03', stage: 3 },
  { id: 'gold', name: '골드', color: '#FFD54F', stage: 5 },
  { id: 'violet', name: '바이올렛', color: '#E040FB', stage: 8 },
  { id: 'ghost', name: '고스트', color: '#EEEEEE', stage: 12 },
];
export interface SaveData {
  gold: number; stage: number; levels: number[]; skinId: string; lastUnix: number;
  lifetimeGold: number; runs: number; portalWins: number; lastStandWins: number; nick: string;
  online: { played: number; wins: number; kills: number; recentMatches: string[] };
}
const integer = (value: unknown, fallback = 0, max = 1e9) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value))) : fallback;
export class TrainingStore {
  save: SaveData;
  storageAvailable = true;
  private hubFraction = 0;
  constructor() {
    const defaults: SaveData = { gold: 40, stage: 1, levels: [0,0,0,0,0,0,0], skinId: 'classic', lastUnix: 0, lifetimeGold: 0, runs: 0, portalWins: 0, lastStandWins: 0, nick: 'PLAYER', online: { played: 0, wins: 0, kills: 0, recentMatches: [] } };
    let source: Partial<SaveData> = {};
    try { const raw = localStorage.getItem(SAVE_KEY); if (raw) { const parsed: unknown = JSON.parse(raw); if (parsed && typeof parsed === 'object') source = parsed as Partial<SaveData>; } } catch { this.storageAvailable = false; }
    this.save = { ...defaults, ...source,
      gold: integer(source.gold, 40), stage: Math.max(1, integer(source.stage, 1, 10000)),
      levels: Array.from({length: 7}, (_, i) => integer(Array.isArray(source.levels) ? source.levels[i] : 0, 0, i === 6 ? 3 : 25)),
      skinId: typeof source.skinId === 'string' && SKINS.some(s => s.id === source.skinId) ? source.skinId : 'classic',
      lastUnix: integer(source.lastUnix, 0, Number.MAX_SAFE_INTEGER), lifetimeGold: integer(source.lifetimeGold), runs: integer(source.runs), portalWins: integer(source.portalWins), lastStandWins: integer(source.lastStandWins),
      nick: typeof source.nick === 'string' ? source.nick.replace(/[\u0000-\u001f]/g, '').trim().slice(0,12) || 'PLAYER' : 'PLAYER',
      online: { played: integer(source.online?.played), wins: integer(source.online?.wins), kills: integer(source.online?.kills), recentMatches: Array.isArray(source.online?.recentMatches) ? source.online.recentMatches.filter((x): x is string => typeof x === 'string').slice(-1000) : [] },
    };
  }
  persist() { this.save.lastUnix = Math.floor(Date.now() / 1000); try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.save)); this.storageAvailable = true; } catch { this.storageAvailable = false; } }
  skin() { return SKINS.find(s => s.id === this.save.skinId && s.stage <= this.save.stage) || SKINS[0]!; }
  goldPerMinute() { return (1.2 + this.save.levels.reduce((a,b) => a + b, 0) * .4 + Math.max(0, this.save.stage - 1) * .7) * (1 + this.save.levels[5]! * .25); }
  cost(index: number) { const level = this.save.levels[index] || 0; return index === 6 ? [80,250,600][level] || 0 : Math.round([15,20,20,18,25,20][index]! * 1.16 ** level); }
  buy(index: number) { if (index < 0 || index > 6) return false; const max = index === 6 ? 3 : 25, price = this.cost(index); if (this.save.levels[index]! >= max || this.save.gold < price) return false; this.save.gold -= price; this.save.levels[index] = this.save.levels[index]! + 1; this.persist(); return true; }
  selectSkin(id: string) { const skin = SKINS.find(s => s.id === id); if (!skin || skin.stage > this.save.stage) return; this.save.skinId = id; this.persist(); }
  addGold(amount: number) { if (!Number.isFinite(amount) || amount <= 0) return; this.save.gold += Math.floor(amount); this.save.lifetimeGold += Math.floor(amount); this.persist(); }
  collectOffline() { const now = Math.floor(Date.now()/1000), elapsed = Math.max(0, now - (this.save.lastUnix || now)); const gold = elapsed >= 60 ? Math.floor(this.goldPerMinute() * Math.min(elapsed, 8 * 3600) / 60) : 0; if (gold) this.addGold(gold); else this.persist(); return gold; }
  tickHub(dt: number) { this.hubFraction += this.goldPerMinute() * dt / 60; const gold = Math.floor(this.hubFraction); if (gold > 0) { this.hubFraction -= gold; this.addGold(gold); return true; } return false; }
  settlePractice(outcome: string, reason: string, kills: number, loot: number, survived: number) {
    if (outcome === 'interrupted' || outcome === 'left') return 0;
    let gold = 5 + kills * 10 + loot * 4 + Math.floor(Math.max(0, survived));
    this.save.runs++;
    if (outcome === 'win' && reason === 'portal') { gold += 40 + this.save.stage * 10; this.save.portalWins++; }
    else if (outcome === 'win' && reason === 'last') { gold += 25 + this.save.stage * 6; this.save.lastStandWins++; }
    else if (outcome === 'survived') gold += 12;
    else gold += 3;
    gold = Math.max(1, Math.round(gold * (1 + Math.max(0,this.save.stage-1) * .08)));
    this.addGold(gold);
    if (outcome === 'win') this.save.stage++;
    this.persist(); return gold;
  }
  recordOnline(matchId: string, outcome: string, kills: number) {
    if (!matchId || ['left','interrupted'].includes(outcome) || this.save.online.recentMatches.includes(matchId)) return false;
    this.save.online.recentMatches.push(matchId); this.save.online.recentMatches = this.save.online.recentMatches.slice(-1000);
    this.save.online.played++; if (outcome === 'win') this.save.online.wins++; this.save.online.kills += integer(kills); this.persist(); return true;
  }
  description(index: number) {
    const lv = this.save.levels[index] || 0;
    return [ `최대 HP +${lv*25}`, `공격력 ×${(1+lv*.08).toFixed(2)}`, `이동 ×${(1+lv*.06).toFixed(2)}`, `스태미나 소모 ×${Math.max(.4,1-lv*.05).toFixed(2)}`, `시작 파밍 +${Math.floor(lv/4)} · 상자 운`, `${this.goldPerMinute().toFixed(1)} G / 분`, ['시작 맨손','시작 나이프','시작 소총 (30)','시작 소총 (45)'][lv] ][index] || '';
  }
}
