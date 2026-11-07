import { BUILD_ID, PROTOCOL_VERSION, packSnapshot, type GameEvent, type Identity, type InputFrame, type JoinReply, type MatchResult, type Outcome, type PlayerResult, type ServerMessage } from '../shared/protocol';
import { GameSim } from '../shared/simulation';
import { LIMITS, ROOM_IDS, charge, freshLedger, resetAt, rollDay, type Lease, type Ledger } from './budget';
import { signClaims, verifyClaims, type Claims } from './tokens';
import { NEUTRAL, acceptFrame, createRateState, parseInput, parseJoin, readLimitedText, type RateState } from './validation';

export interface Env {
  ADMISSION: DurableObjectNamespace;
  ROOMS: DurableObjectNamespace;
  ONLINE_ENABLED?: string;
  ALLOWED_ORIGIN?: string;
  DEV_BYPASS?: string;
  HMAC_SECRET?: string;
  TURNSTILE_SECRET?: string;
  ADMIN_SECRET?: string;
}
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const error = (reason: string, status = 400, extra: Record<string, unknown> = {}) => json({ error: reason, reason, ...extra }, status);
const getStub = (namespace: DurableObjectNamespace, name: string) => namespace.get(namespace.idFromName(name), { locationHint: 'apac-ne' });
/** Bound coordinator pending-I/O duration; clear the timeout before returning an upgraded socket. */
export async function boundedRoomFetch(stub: DurableObjectStub, input: Request | string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = new Request(input, { ...init, signal: controller.signal });
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { const failure = new Error('Room request timed out'); controller.abort(failure); reject(failure); }, 1000); });
    return await Promise.race([stub.fetch(request), timeout]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
const localHost = (hostname: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
export function isLocalBypass(request: Request, env: Env): boolean {
  return env.DEV_BYPASS === 'true' && localHost(new URL(request.url).hostname);
}
export function allowedOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  if (origin === (env.ALLOWED_ORIGIN || 'https://emptypizza.github.io') && origin === 'https://emptypizza.github.io') return true;
  try { const candidate = new URL(origin); return isLocalBypass(request, env) && localHost(candidate.hostname) && ['http:', 'https:'].includes(candidate.protocol); } catch { return false; }
}
async function validateChallenge(request: Request, token: string, env: Env): Promise<boolean> {
  if (isLocalBypass(request, env)) return true;
  if (!env.TURNSTILE_SECRET || !token) return false;
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: request.headers.get('CF-Connecting-IP') || undefined }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const proof = await response.json() as { success?: boolean; hostname?: string; action?: string };
    return proof.success === true && proof.hostname === 'emptypizza.github.io' && proof.action === 'ppi-io-join';
  } catch { return false; }
}
function tokenFrom(url: URL): string | null { return url.searchParams.get('ticket') || url.searchParams.get('resume') || url.searchParams.get('resumeToken'); }
function cors(response: Response, origin: string): Response {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin); headers.set('Vary', 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/admin') {
      if (!env.ADMIN_SECRET || env.ADMIN_SECRET.length < 32 || request.headers.get('Authorization') !== `Bearer ${env.ADMIN_SECRET}`) return error('unauthorized', 401);
      if (!['GET', 'POST'].includes(request.method)) return error('method_not_allowed', 405);
      if (Number(request.headers.get('Content-Length') || 0) > 512) return error('body_too_large', 413);
      return getStub(env.ADMISSION, 'admission-v1').fetch(request);
    }
    if (!['/api/join', '/api/ws', '/api/result'].includes(url.pathname)) return error('not_found', 404);
    if (!allowedOrigin(request, env)) return error('origin_not_allowed', 403);
    const origin = request.headers.get('Origin')!;
    const reply = async (): Promise<Response> => {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' } });
      if (env.ONLINE_ENABLED !== 'true') return error('online_disabled', 503);
      if (!env.HMAC_SECRET || env.HMAC_SECRET.length < 32) return error('not_configured', 503);
      if (url.pathname === '/api/join') {
        if (request.method !== 'POST') return error('method_not_allowed', 405);
        if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return error('invalid_content_type', 415);
        if (Number(request.headers.get('Content-Length') || 0) > 4096) return error('body_too_large', 413);
        let body: unknown;
        try { const raw = await readLimitedText(request, 4096); if (raw === null) return error('body_too_large', 413); body = JSON.parse(raw); } catch { return error('invalid_json'); }
        const join = parseJoin(body); if (!join) return error('invalid_join');
        // Proof validation happens before even obtaining a Durable Object stub.
        if (!(await validateChallenge(request, join.challengeToken, env))) return error('challenge_failed', 403);
        return getStub(env.ADMISSION, 'admission-v1').fetch(new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(join) }));
      }
      if (request.method !== 'GET') return error('method_not_allowed', 405);
      if (url.pathname === '/api/ws' && request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return error('websocket_required', 426);
      const claims = await verifyClaims(tokenFrom(url) || '', env.HMAC_SECRET);
      if (!claims) return error('invalid_ticket', 401);
      if (url.pathname === '/api/result' && url.searchParams.get('matchId') !== claims.matchId) return error('invalid_match', 403);
      if (url.pathname === '/api/ws' && claims.deadline <= Date.now()) return error('room_expired', 410);
      return getStub(env.ADMISSION, 'admission-v1').fetch(request);
    };
    try { return cors(await reply(), origin); } catch { return cors(error('temporarily_unavailable', 503), origin); }
  },
};

/** The only allocator. Exactly two named room objects can ever be addressed. */
export class AdmissionDO {
  private ledger!: Ledger;
  private ready: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private state: DurableObjectState, private env: Env) {
    this.ready = state.blockConcurrencyWhile(async () => { this.ledger = await state.storage.get<Ledger>('ledger') || freshLedger(Date.now()); });
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> { const result = this.queue.then(fn, fn); this.queue = result.then(() => {}, () => {}); return result; }
  private async persist() { await this.state.storage.put('ledger', this.ledger); }
  private exhausted(now: number) { return error('daily_budget_exhausted', 503, { resetAt: resetAt(now) }); }
  async fetch(request: Request): Promise<Response> {
    await this.ready;
    return this.exclusive(async () => {
      const now = Date.now(); this.ledger = rollDay(this.ledger, now);
      const url = new URL(request.url);
      if (url.pathname === '/api/admin') {
        if (request.method === 'POST') {
          let value: unknown;
          try { const raw = await readLimitedText(request, 512); if (raw === null) return error('body_too_large', 413); value = JSON.parse(raw); } catch { return error('invalid_json'); }
          if (!value || typeof value !== 'object' || typeof (value as { online?: unknown }).online !== 'boolean') return error('invalid_admin_request');
          this.ledger.paused = !(value as { online: boolean }).online;
        }
        charge(this.ledger, { controls: 1 }); await this.refreshRooms(now); await this.persist();
        return json({ online: this.env.ONLINE_ENABLED === 'true' && !this.ledger.paused, paused: this.ledger.paused, configuredOnline: this.env.ONLINE_ENABLED === 'true', resetAt: resetAt(now), rooms: this.ledger.leases, budget: { admission: this.ledger.admission, control: this.ledger.control, duration: this.ledger.duration }, limits: LIMITS });
      }
      if (!charge(this.ledger, { controls: 1 })) { await this.persist(); return this.exhausted(now); }
      await this.persist();
      if (url.pathname === '/api/join') return this.ledger.paused ? error('admissions_paused', 503) : this.join(request, now);
      const claims = await verifyClaims(tokenFrom(url) || '', this.env.HMAC_SECRET || '', now);
      if (!claims) return error('invalid_ticket', 401);
      const room = getStub(this.env.ROOMS, claims.roomId);
      const target = new URL(request.url); target.hostname = 'room.internal';
      target.pathname = url.pathname === '/api/ws' ? '/socket' : '/result';
      try { return await boundedRoomFetch(room, new Request(target, request)); } catch { return error('temporarily_unavailable', 503); }
    });
  }
  /** Inspect lifecycle only on joins/admin reads. Room objects never call back into this allocator. */
  private async refreshRooms(now: number): Promise<boolean> {
    for (const lease of [...this.ledger.leases]) {
      if (!charge(this.ledger, { controls: 1 })) { await this.persist(); return false; }
      await this.persist();
      try {
        const response = await boundedRoomFetch(getStub(this.env.ROOMS, lease.roomId), 'https://room.internal/status');
        if (!response.ok) { lease.closed = true; continue; }
        const status = await response.json() as { phase: string; occupied: number; nextPlayerId: number; generation: number; matchId: string };
        if (status.matchId !== lease.matchId || status.generation !== lease.generation || status.phase === 'ended' || lease.deadline <= now) this.ledger.leases = this.ledger.leases.filter(value => value !== lease);
        else { lease.seats = status.occupied; lease.nextPlayerId = status.nextPlayerId; lease.closed = status.phase !== 'lobby'; }
      } catch { lease.closed = true; }
    }
    await this.persist(); return true;
  }
  private async join(request: Request, now: number): Promise<Response> {
    const body = parseJoin(await request.json()); if (!body) return error('invalid_join');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.requestId + '\n' + body.challengeToken + '\n' + body.nick + '\n' + body.color));
    const requestKey = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const previous = this.ledger.requests[requestKey];
    const reply = (lease: Lease, ticket: string): Response => {
      const ws = new URL('/api/ws', request.url); ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:'; ws.searchParams.set('ticket', ticket);
      const result: JoinReply = { roomId: lease.roomId, generation: lease.generation, matchId: lease.matchId, ticket, wsUrl: ws.toString(), deadline: lease.deadline };
      return json(result);
    };
    if (previous) {
      const existing = this.ledger.leases.find(lease => lease.matchId === previous.matchId);
      if (existing) return reply(existing, previous.ticket);
    }
    if (!(await this.refreshRooms(now))) return this.exhausted(now);
    const candidates: Array<{ lease: Lease; fresh: boolean }> = [];
    for (const roomId of ROOM_IDS) {
      const existing = this.ledger.leases.find(lease => lease.roomId === roomId);
      if (existing && !existing.closed && existing.seats < LIMITS.seats) candidates.push({ lease: existing, fresh: false });
    }
    for (const roomId of ROOM_IDS) if (!this.ledger.leases.some(lease => lease.roomId === roomId)) {
      const generation = (this.ledger.generations[roomId] || 0) + 1;
      candidates.push({ lease: { roomId, generation, matchId: `${roomId}-${generation}-${crypto.randomUUID()}`, reservedAt: now, deadline: now + LIMITS.roomMs, seats: 0, closed: false }, fresh: true });
    }
    for (const candidate of candidates) {
      const { lease, fresh } = candidate;
      if (!charge(this.ledger, { tickets: 1, rooms: fresh ? 1 : 0, controls: 1 })) { await this.persist(); return this.exhausted(now); }
      if (fresh) { this.ledger.leases.push(lease); this.ledger.generations[lease.roomId] = lease.generation; }
      const playerId = lease.nextPlayerId ?? lease.seats; lease.seats++; delete lease.nextPlayerId; const nonce = crypto.randomUUID();
      const claims: Claims = { v: 1, kind: 'ticket', roomId: lease.roomId, generation: lease.generation, matchId: lease.matchId, playerId, nonce, deadline: lease.deadline, expiresAt: lease.deadline + LIMITS.resultMs };
      const ticket = await signClaims(claims, this.env.HMAC_SECRET!);
      await this.persist(); // Reserve budget and capacity before any room side effect. No refunds.
      let reservation: Response;
      try {
        reservation = await boundedRoomFetch(getStub(this.env.ROOMS, lease.roomId), 'https://room.internal/reserve', { method: 'POST', body: JSON.stringify({ lease, player: { id: playerId, nick: body.nick, color: body.color, bot: false }, nonce }) });
      } catch { lease.closed = true; await this.persist(); return error('temporarily_unavailable', 503); }
      if (!reservation.ok) { lease.closed = true; await this.persist(); continue; }
      this.ledger.requests[requestKey] = { roomId: lease.roomId, matchId: lease.matchId, playerId, ticket, deadline: lease.deadline, expiresAt: now + LIMITS.reservationMs };
      await this.persist(); return reply(lease, ticket);
    }
    return error('rooms_full', 503, { retryAt: Math.min(...this.ledger.leases.map(lease => lease.deadline)) });
  }
}

interface Member { identity: Identity; ticketNonce: string; ticketExpiresAt: number; used: boolean; resumeNonce: string; resumes: number; disconnectedAt: number | null; forfeited: boolean; lastSeq: number }
interface RoomMeta { roomId: string; generation: number; matchId: string; reservedAt: number; deadline: number; lobbyEndsAt: number | null; phase: 'lobby' | 'running' | 'ended'; seed: number; members: Member[] }
interface Session { ws: WebSocket; connectionId: string; playerId: number; seq: number; input: InputFrame | null; lastInputAt: number; rate: RateState; firePending: boolean }
interface StoredResult { matchId: string; generation: number; result: MatchResult; players: Record<string, PlayerResult>; auth: Record<string, string[]>; expiresAt: number }
interface Attachment { matchId: string; generation: number; playerId: number; connectionId: string }
const interrupted = (members: Member[]): MatchResult => ({ reason: 'interrupted', winnerId: null, outcomes: Object.fromEntries(members.map(member => [String(member.identity.id), 'interrupted' as Outcome])) });

/** Simulation is deliberately ephemeral; an isolate reset ends that generation. */
export class RoomDO {
  private meta: RoomMeta | null = null;
  private sim: GameSim | null = null;
  private sessions = new Map<number, Session>();
  private reports = new Map<number, PlayerResult>();
  private ready: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastScheduler = 0;
  private accumulator = 0;
  private lastState = 0;
  private pendingEvents: GameEvent[] = [];
  private finishing = false;
  constructor(private state: DurableObjectState, private env: Env) {
    this.ready = state.blockConcurrencyWhile(async () => {
      this.meta = await state.storage.get<RoomMeta>('meta') || null;
      if (this.meta && this.meta.phase !== 'ended') {
        const settled = await state.storage.list<{ player: PlayerResult; expiresAt: number }>({ prefix: `player:${this.meta.matchId}:` });
        for (const entry of settled.values()) if (entry.expiresAt > Date.now()) this.reports.set(entry.player.playerId, entry.player);
        // A missing in-memory sim is never silently reconstructed into another match.
        await this.finish('server_restarted');
      }
      for (const ws of state.getWebSockets()) { this.send(ws, { type: 'closed', reason: 'server_restarted' }); try { ws.close(1012, 'server_restarted'); } catch {} }
      await this.pruneResults();
    });
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> { const result = this.queue.then(fn, fn); this.queue = result.then(() => {}, () => {}); return result; }
  private async persist() { if (this.meta) await this.state.storage.put('meta', this.meta); }
  private send(ws: WebSocket, message: ServerMessage) { try { if (ws.readyState === 1) ws.send(JSON.stringify(message)); } catch {} }
  private broadcast(message: ServerMessage) { for (const session of this.sessions.values()) this.send(session.ws, message); }
  private roster(): Identity[] { return this.meta?.members.filter(member => member.used && !member.forfeited).map(member => member.identity) || []; }
  private member(id: number) { return this.meta?.members.find(member => member.identity.id === id); }
  private schedule() {
    if (this.timer) return;
    this.lastScheduler = Date.now();
    this.timer = setInterval(() => { void this.exclusive(() => this.step()).catch(() => this.finish('server_error')); }, 50);
  }
  async fetch(request: Request): Promise<Response> {
    await this.ready;
    return this.exclusive(async () => {
      const url = new URL(request.url);
      if (url.pathname === '/reserve' && request.method === 'POST') return this.reserve(request);
      if (url.pathname === '/status') {
        await this.expireReservations(Date.now());
        return json(this.meta ? { roomId: this.meta.roomId, generation: this.meta.generation, matchId: this.meta.matchId, phase: this.meta.phase, occupied: this.meta.members.length, nextPlayerId: Array.from({ length: 10 }, (_, id) => id).find(id => !this.member(id)) ?? -1, deadline: this.meta.deadline, lobbyEndsAt: this.meta.lobbyEndsAt } : { phase: 'ended', occupied: 0, nextPlayerId: 0 });
      }
      const claims = await verifyClaims(tokenFrom(url) || '', this.env.HMAC_SECRET || '');
      if (!claims) return error('invalid_ticket', 401);
      if (url.pathname === '/result') return this.result(claims, url.searchParams.get('matchId'));
      if (url.pathname !== '/socket') return error('not_found', 404);
      return this.connect(request, claims);
    });
  }
  private async reserve(request: Request): Promise<Response> {
    const { lease, player, nonce } = await request.json() as { lease: Lease; player: Identity; nonce: string };
    const now = Date.now();
    if (!(ROOM_IDS as readonly string[]).includes(lease.roomId) || lease.deadline <= now || lease.deadline - lease.reservedAt !== LIMITS.roomMs || player.id < 0 || player.id >= 10) return error('invalid_reservation');
    if (!this.meta || this.meta.matchId !== lease.matchId) {
      if (this.meta && (lease.generation <= this.meta.generation || (this.meta.phase !== 'ended' && now < this.meta.deadline))) return error('generation_busy', 409);
      if (this.meta?.phase !== 'ended' && this.meta) await this.finish('deadline');
      this.finishing = false; this.sim = null; this.sessions.clear(); this.reports.clear(); this.pendingEvents = []; this.accumulator = 0; this.lastState = 0;
      this.meta = { roomId: lease.roomId, generation: lease.generation, matchId: lease.matchId, reservedAt: lease.reservedAt, deadline: lease.deadline, lobbyEndsAt: null, phase: 'lobby', seed: crypto.getRandomValues(new Uint32Array(1))[0], members: [] };
      await this.pruneResults();
    }
    const meta = this.meta;
    if (meta.phase !== 'lobby' || (meta.lobbyEndsAt !== null && now >= meta.lobbyEndsAt) || meta.members.length >= 10) return error('lobby_closed', 409);
    if (meta.members.some(member => member.identity.id === player.id)) return error('slot_reserved', 409);
    meta.members.push({ identity: player, ticketNonce: nonce, ticketExpiresAt: now + LIMITS.reservationMs, used: false, resumeNonce: '', resumes: 0, disconnectedAt: null, forfeited: false, lastSeq: -1 });
    await this.persist(); this.schedule(); return json({ reserved: true });
  }
  private async connect(request: Request, claims: Claims): Promise<Response> {
    const meta = this.meta; const now = Date.now();
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return error('websocket_required', 426);
    if (!meta || meta.matchId !== claims.matchId || meta.generation !== claims.generation || meta.roomId !== claims.roomId) return error('stale_generation', 410);
    if (meta.phase === 'ended' || now >= meta.deadline) return error('match_ended', 410);
    const member = this.member(claims.playerId); if (!member || member.forfeited) return error('slot_closed', 410);
    const oldSession = this.sessions.get(claims.playerId);
    if (claims.kind === 'ticket') {
      if (oldSession) return error('already_connected', 409);
      if (member.used || member.ticketNonce !== claims.nonce) return error('ticket_used', 409);
      if (now >= member.ticketExpiresAt) return error('ticket_expired', 410);
      if (meta.phase !== 'lobby' || (meta.lobbyEndsAt !== null && now >= meta.lobbyEndsAt)) return error('lobby_closed', 410);
      member.used = true;
      if (meta.lobbyEndsAt === null) meta.lobbyEndsAt = Math.min(now + LIMITS.lobbyMs, meta.deadline);
    } else {
      const disconnectedAt = member.disconnectedAt ?? oldSession?.lastInputAt;
      if (!member.used || member.resumeNonce !== claims.nonce || disconnectedAt === undefined || now - disconnectedAt > LIMITS.resumeMs || member.resumes >= LIMITS.maxResumes) return error('resume_expired', 410);
      if (oldSession) { this.sessions.delete(claims.playerId); try { oldSession.ws.close(1000, 'session_replaced'); } catch {} }
      member.resumes++;
    }
    member.disconnectedAt = null; member.resumeNonce = crypto.randomUUID();
    const resumeToken = await signClaims({ ...claims, kind: 'resume', nonce: member.resumeNonce, expiresAt: meta.deadline + LIMITS.resultMs }, this.env.HMAC_SECRET!);
    const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
    const connectionId = crypto.randomUUID();
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ matchId: meta.matchId, generation: meta.generation, playerId: claims.playerId, connectionId } satisfies Attachment);
    this.sessions.set(claims.playerId, { ws: server, connectionId, playerId: claims.playerId, seq: member.lastSeq, input: null, lastInputAt: now, rate: createRateState(now), firePending: false });
    await this.persist(); this.schedule();
    this.send(server, { type: 'welcome', roomId: meta.roomId, generation: meta.generation, matchId: meta.matchId, playerId: claims.playerId, resumeToken, deadline: meta.deadline, lobbyEndsAt: meta.lobbyEndsAt || now, players: this.roster() });
    if (meta.phase === 'lobby' && this.sessions.size === 10) await this.beginMatch(now);
    else if (meta.phase === 'running' && this.sim) this.sendStart(server);
    const report = this.reports.get(claims.playerId); if (report) this.send(server, { type: 'player_result', ...report });
    this.broadcast({ type: 'roster', players: this.roster(), lobbyEndsAt: meta.lobbyEndsAt || now });
    return new Response(null, { status: 101, webSocket: client });
  }
  private sendStart(ws: WebSocket) {
    if (!this.meta || !this.sim) return;
    const roster = this.sim.snapshot().entities.map(actor => this.member(actor.id)?.used && !this.member(actor.id)?.forfeited ? this.member(actor.id)!.identity : { id: actor.id, nick: `BOT ${actor.id + 1}`, color: '#FF5252', bot: true });
    this.send(ws, { type: 'start', matchId: this.meta.matchId, generation: this.meta.generation, map: this.sim.mapSnapshot(), roster, snapshot: packSnapshot(this.sim.snapshot()) });
  }
  private async beginMatch(now: number) {
    if (!this.meta || this.meta.phase !== 'lobby') return;
    for (const member of this.meta.members) if (!member.used) member.forfeited = true;
    const humans = this.meta.members.filter(member => member.used && !member.forfeited).map(member => ({ id: member.identity.id, nick: member.identity.nick, color: member.identity.color }));
    if (!humans.length) { await this.finish('empty_lobby'); return; }
    this.sim = new GameSim({ seed: this.meta.seed, humans, bots: 10 - humans.length, practice: false });
    this.meta.phase = 'running'; this.lastScheduler = now; this.accumulator = 0;
    await this.persist(); for (const session of this.sessions.values()) this.sendStart(session.ws);
  }
  private async step(): Promise<void> {
    const meta = this.meta; if (!meta || meta.phase === 'ended' || this.finishing) return;
    const now = Date.now(); const elapsed = now - this.lastScheduler; this.lastScheduler = now;
    if (now >= meta.deadline) { await this.finish('deadline'); return; }
    if (elapsed > 500 || elapsed < 0) { await this.finish('server_lag'); return; }
    await this.expireReservations(now); if (this.finishing) return;
    for (const member of meta.members) if (member.used && !member.forfeited && member.disconnectedAt !== null && now - member.disconnectedAt > LIMITS.resumeMs) {
      member.forfeited = true; this.sim?.disconnect(member.identity.id); await this.persist();
    }
    if (meta.phase === 'lobby') { if (meta.lobbyEndsAt !== null && now >= meta.lobbyEndsAt) await this.beginMatch(now); return; }
    const sim = this.sim; if (!sim) { await this.finish('server_restarted'); return; }
    this.accumulator += elapsed / 1000;
    if (this.accumulator > 0.5) { await this.finish('server_lag'); return; }
    let steps = 0;
    while (this.accumulator + 1e-9 >= 1 / 60 && steps++ < 9 && !sim.ended) {
      for (const member of meta.members.filter(member => member.used && !member.forfeited)) {
        const session = this.sessions.get(member.identity.id);
        const valid = session && session.input && now - session.lastInputAt <= 500;
        const input = valid ? session.input! : null;
        sim.setInput(member.identity.id, input ? { dx: input.dx, dy: input.dy, aim: input.aim, attack: input.attack, firePressed: session!.firePending, sprint: input.sprint } : { ...NEUTRAL });
        if (session) session.firePending = false;
      }
      sim.tick(1 / 60); this.accumulator -= 1 / 60; this.pendingEvents.push(...sim.drainEvents());
    }
    for (const member of meta.members.filter(member => member.used)) {
      const actor = sim.entity(member.identity.id);
      if (actor && !actor.alive && !this.reports.has(member.identity.id)) await this.reportPlayer(member, sim.result?.outcomes[String(member.identity.id)] || (member.forfeited ? 'left' : 'death'));
    }
    if (sim.ended) { await this.finish(); return; }
    if (now - this.lastState >= 100) {
      this.lastState = now; const snapshot = packSnapshot(sim.snapshot()); const events = this.pendingEvents.splice(0);
      for (const session of this.sessions.values()) this.send(session.ws, { type: 'state', matchId: meta.matchId, generation: meta.generation, snapshot, events, ack: session.seq });
    }
  }
  private async expireReservations(now: number) {
    if (!this.meta || this.meta.phase !== 'lobby') return;
    const before = this.meta.members.length;
    this.meta.members = this.meta.members.filter(member => member.used || now < member.ticketExpiresAt);
    if (this.meta.members.length !== before) {
      if (!this.meta.members.length) await this.finish('reservation_expired');
      else await this.persist();
    }
  }
  private async reportPlayer(member: Member, outcome: Outcome): Promise<PlayerResult> {
    const actor = this.sim?.entity(member.identity.id);
    const result: PlayerResult = { matchId: this.meta!.matchId, playerId: member.identity.id, outcome, kills: actor?.kills || 0, lootCount: actor?.lootCount || 0 };
    this.reports.set(member.identity.id, result);
    await this.state.storage.put(`player:${result.matchId}:${result.playerId}`, { player: result, expiresAt: Date.now() + LIMITS.resultMs });
    const session = this.sessions.get(member.identity.id); if (session) this.send(session.ws, { type: 'player_result', ...result });
    return result;
  }
  private async finish(reason?: string): Promise<void> {
    if (!this.meta || this.meta.phase === 'ended' || this.finishing) return;
    this.finishing = true; if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (reason && this.sim && !this.sim.ended) this.sim.interrupt();
    const result = this.sim?.result || interrupted(this.meta.members);
    for (const [id, report] of this.reports) result.outcomes[String(id)] = report.outcome;
    for (const member of this.meta.members) {
      if (!(String(member.identity.id) in result.outcomes)) result.outcomes[String(member.identity.id)] = member.forfeited ? 'left' : 'interrupted';
    }
    const players: Record<string, PlayerResult> = {};
    for (const member of this.meta.members) {
      const existing = this.reports.get(member.identity.id);
      const outcome = result.outcomes[String(member.identity.id)] || 'interrupted';
      players[String(member.identity.id)] = existing || await this.reportPlayer(member, outcome);
    }
    this.meta.phase = 'ended';
    const auth = Object.fromEntries(this.meta.members.map(member => [String(member.identity.id), [member.ticketNonce, member.resumeNonce].filter(Boolean)]));
    const stored: StoredResult = { matchId: this.meta.matchId, generation: this.meta.generation, result, players, auth, expiresAt: Date.now() + LIMITS.resultMs };
    await this.state.storage.put({ meta: this.meta, [`result:${this.meta.matchId}`]: stored });
    this.broadcast({ type: 'match_result', matchId: this.meta.matchId, result });
    this.broadcast({ type: 'closed', reason: reason || 'complete' });
    for (const session of this.sessions.values()) { try { session.ws.close(1000, reason || 'complete'); } catch {} }
    this.sessions.clear(); this.sim = null; this.pendingEvents = [];
  }
  private async result(claims: Claims, requestedMatch: string | null): Promise<Response> {
    if (requestedMatch !== claims.matchId) return error('invalid_match', 403);
    const stored = await this.state.storage.get<StoredResult>(`result:${claims.matchId}`);
    if (stored && stored.generation === claims.generation && stored.expiresAt > Date.now()) {
      if (!stored.auth?.[String(claims.playerId)]?.includes(claims.nonce)) return error('not_a_participant', 403);
      const player = stored.players[String(claims.playerId)]; if (!player) return error('not_a_participant', 403);
      return json({ matchId: stored.matchId, result: stored.result, player, expiresAt: stored.expiresAt });
    }
    const member = this.meta?.matchId === claims.matchId ? this.member(claims.playerId) : undefined;
    if (!member || ![member.ticketNonce, member.resumeNonce].includes(claims.nonce)) return error('not_a_participant', 403);
    const player = await this.state.storage.get<{ player: PlayerResult; expiresAt: number }>(`player:${claims.matchId}:${claims.playerId}`);
    if (player && player.expiresAt > Date.now()) return json({ matchId: claims.matchId, result: null, player: player.player, expiresAt: player.expiresAt });
    if (this.meta?.matchId === claims.matchId && this.meta.generation === claims.generation && this.meta.phase !== 'ended') return json({ matchId: claims.matchId, pending: true, deadline: this.meta.deadline }, 202);
    return error('result_expired', 410);
  }
  private async pruneResults() {
    const entries = await this.state.storage.list<StoredResult>({ prefix: 'result:' });
    const expired: string[] = [];
    for (const [key, entry] of entries) if (entry.expiresAt <= Date.now()) { expired.push(key, ...Object.keys(entry.players).map(id => `player:${entry.matchId}:${id}`)); }
    for (let offset = 0; offset < expired.length; offset += 128) await this.state.storage.delete(expired.slice(offset, offset + 128));
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.ready;
    return this.exclusive(async () => {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      const session = attachment && this.sessions.get(attachment.playerId);
      if (!attachment || !session || session.ws !== ws || session.connectionId !== attachment.connectionId || attachment.matchId !== this.meta?.matchId || attachment.generation !== this.meta?.generation || this.meta.phase === 'ended') { try { ws.close(1008, 'stale_connection'); } catch {} return; }
      let input: InputFrame | null = null;
      if (typeof message === 'string' && message.length <= 512) { try { input = parseInput(JSON.parse(message)); } catch {} }
      if (!input || !acceptFrame(session.rate, Date.now())) { await this.disconnectSocket(ws, 1008, input ? 'input_rate' : 'invalid_input'); return; }
      if (input.seq <= session.seq) return;
      session.seq = input.seq; session.input = input; session.lastInputAt = Date.now(); session.firePending ||= input.firePressed;
      const member = this.member(session.playerId); if (member) member.lastSeq = input.seq;
    });
  }
  private async disconnectSocket(ws: WebSocket, code?: number, reason?: string) {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    const session = attachment && this.sessions.get(attachment.playerId);
    if (session?.ws === ws) {
      this.sessions.delete(session.playerId);
      const member = this.member(session.playerId);
      if (member && this.meta?.phase !== 'ended') { member.disconnectedAt = Date.now(); await this.persist(); }
      this.sim?.setInput(session.playerId, { ...NEUTRAL });
    }
    if (code) { try { ws.close(code, reason); } catch {} }
  }
  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean) { await this.ready; await this.exclusive(() => this.disconnectSocket(ws)); }
  async webSocketError(ws: WebSocket) { await this.ready; await this.exclusive(() => this.disconnectSocket(ws, 1011, 'connection_error')); }
}
