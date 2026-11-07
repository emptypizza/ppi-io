import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { AdmissionDO, RoomDO, allowedOrigin, boundedRoomFetch, isLocalBypass, type Env } from './index';
import { LIMITS, charge, freshLedger, resetAt, rollDay, type Lease } from './budget';
import { signClaims, verifyClaims, type Claims } from './tokens';
import { acceptFrame, createRateState, parseInput, parseJoin, readLimitedText } from './validation';

const secret = 'test-only-secret-with-at-least-thirty-two-characters';
const now = Date.parse('2026-11-07T12:00:00Z');
const join = (requestId = crypto.randomUUID()) => ({ protocol: 1, build: '0.1.0', nick: '플레이어', color: '#00BFFF', challengeToken: 'proof', requestId });
function memoryState() {
  const values = new Map<string, unknown>();
  const storage = {
    async get(key: string) { return structuredClone(values.get(key)); },
    async put(key: string | Record<string, unknown>, value?: unknown) { if (typeof key === 'string') values.set(key, structuredClone(value)); else for (const [name, item] of Object.entries(key)) values.set(name, structuredClone(item)); },
    async list(options: { prefix: string }) { return new Map([...values.entries()].filter(([key]) => key.startsWith(options.prefix)).map(([key, value]) => [key, structuredClone(value)])); },
    async delete(keys: string | string[]) { for (const key of typeof keys === 'string' ? [keys] : keys) values.delete(key); },
  };
  return { state: { storage, blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(), getWebSockets: () => [] } as unknown as DurableObjectState, values };
}
function environment(roomFetch = vi.fn(async () => Response.json({ reserved: true }))) {
  const rooms = new Map<string, { lease: Lease; ids: number[] }>();
  const env = { HMAC_SECRET: secret, ADMIN_SECRET: secret, ONLINE_ENABLED: 'true', DEV_BYPASS: 'true', ALLOWED_ORIGIN: 'https://emptypizza.github.io', ADMISSION: undefined, ROOMS: { idFromName: (name: string) => name, get: (name: string) => ({ fetch: async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.endsWith('/status')) { const room = rooms.get(name); return Response.json(room ? { phase: 'lobby', occupied: room.ids.length, nextPlayerId: Array.from({ length: 10 }, (_, id) => id).find(id => !room.ids.includes(id)) ?? -1, generation: room.lease.generation, matchId: room.lease.matchId } : { phase: 'ended', occupied: 0, nextPlayerId: 0 }); }
    const response = await roomFetch();
    if (response.ok && url.endsWith('/reserve')) { const body = JSON.parse(typeof input === 'string' ? String(init?.body) : await input.text()) as { lease: Lease; player: { id: number } }; const room = rooms.get(name); if (room?.lease.matchId === body.lease.matchId) room.ids.push(body.player.id); else rooms.set(name, { lease: body.lease, ids: [body.player.id] }); }
    return response;
  } }) } } as unknown as Env;
  return { env, roomFetch };
}
const joinRequest = (body = join()) => new Request('http://127.0.0.1/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' }, body: JSON.stringify(body) });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('free budget boundaries and UTC carry', () => {
  it('does not exceed any request, control, or duration budget', () => {
    const requests = freshLedger(now); expect(charge(requests, { tickets: 1000 })).toBe(true); expect(charge(requests, { tickets: 1 })).toBe(false); expect(requests.admission).toBe(60_000);
    const duration = freshLedger(now); expect(charge(duration, { rooms: 750 })).toBe(true); expect(charge(duration, { rooms: 1 })).toBe(false); expect(duration.duration).toBe(9000);
    const control = freshLedger(now); expect(charge(control, { controls: 10_000 })).toBe(true); expect(charge(control, { controls: 1 })).toBe(false);
  });
  it('does not refund expired same-day reservations, but carries only active reservations across UTC', () => {
    const before = Date.parse('2026-11-07T23:59:50Z'); const ledger = freshLedger(before);
    charge(ledger, { tickets: 20, rooms: 2, controls: 40 });
    ledger.leases = [{ roomId: 'room-1', generation: 7, matchId: 'active', reservedAt: before, deadline: before + 90_000, seats: 7, closed: false }, { roomId: 'room-2', generation: 3, matchId: 'expired', reservedAt: before - 120_000, deadline: before - 30_000, seats: 10, closed: true }];
    ledger.generations = { 'room-1': 7, 'room-2': 3 };
    expect(rollDay(ledger, before).admission).toBe(1200);
    const next = rollDay(ledger, before + 20_000);
    expect(next.admission).toBe(420); expect(next.duration).toBe(12); expect(next.control).toBe(0); expect(next.leases).toHaveLength(1); expect(next.generations['room-1']).toBe(7);
    expect(resetAt(before)).toBe(Date.parse('2026-11-08T00:00:00Z'));
    const late = rollDay(ledger, before + 180_000);
    expect(late.leases).toHaveLength(0); expect(late.admission).toBe(420); expect(late.duration).toBe(12);
  });
  it('aborts a hung room call within one second and clears watchdogs after completed upgrades', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null = null;
    const hung = { fetch: (request: Request) => { signal = request.signal; return new Promise<Response>(() => {}); } } as unknown as DurableObjectStub;
    const pending = boundedRoomFetch(hung, 'https://room.internal/status');
    const failure = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(1000); await failure; expect((signal as unknown as AbortSignal).aborted).toBe(true);
    let completeSignal: AbortSignal | null = null;
    const complete = { fetch: async (request: Request) => { completeSignal = request.signal; return Response.json({ ok: true }); } } as unknown as DurableObjectStub;
    expect((await boundedRoomFetch(complete, 'https://room.internal/socket')).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(2000); expect((completeSignal as unknown as AbortSignal).aborted).toBe(false);
  });
});

describe('signed generation tokens', () => {
  const claims: Claims = { v: 1, kind: 'ticket', roomId: 'room-1', generation: 3, matchId: 'room-1-3-unique', playerId: 2, nonce: 'unique-nonce-long-enough', deadline: now + 90_000, expiresAt: now + LIMITS.resultMs };
  it('authenticates valid claims but rejects changed identity, wrong secret, malformed and expired values', async () => {
    const token = await signClaims(claims, secret); expect(await verifyClaims(token, secret, now)).toEqual(claims);
    const [payload, signature] = token.split('.');
    const modified = btoa(JSON.stringify({ ...claims, generation: 4 })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    expect(await verifyClaims(`${modified}.${signature}`, secret, now)).toBeNull();
    expect(await verifyClaims(token, secret + '-wrong', now)).toBeNull(); expect(await verifyClaims(token, secret, claims.expiresAt)).toBeNull();
    expect(await verifyClaims(payload + '..' + signature, secret, now)).toBeNull();
    expect(await verifyClaims(await signClaims({ ...claims, roomId: 'attacker-created-room' }, secret), secret, now)).toBeNull();
  });
});

describe('proof, origin and input validation before allocation', () => {
  it('never enables DEV_BYPASS on a public Worker hostname', () => {
    const { env } = environment();
    expect(isLocalBypass(new Request('https://public-worker.workers.dev/api/join'), env)).toBe(false);
    expect(allowedOrigin(new Request('http://127.0.0.1/api/join', { headers: { Origin: 'http://localhost:5173' } }), env)).toBe(true);
    expect(allowedOrigin(new Request('https://public-worker.workers.dev/api/join', { headers: { Origin: 'http://localhost:5173' } }), env)).toBe(false);
    expect(allowedOrigin(new Request('https://public-worker.workers.dev/api/join', { headers: { Origin: 'https://evil.example' } }), env)).toBe(false);
  });
  it('rejects bad proof and public developer bypass without touching any Durable Object', async () => {
    const { env } = environment(); const allocation = vi.fn(); env.ADMISSION = { idFromName: allocation } as unknown as DurableObjectNamespace;
    const request = new Request('https://ppi-io.workers.dev/api/join', { method: 'POST', headers: { Origin: 'https://emptypizza.github.io', 'Content-Type': 'application/json' }, body: JSON.stringify(join()) });
    expect((await worker.fetch(request, env)).status).toBe(403); expect(allocation).not.toHaveBeenCalled();
  });
  it('requires the correct Turnstile action and hostname before allocating', async () => {
    const { env } = environment(); env.TURNSTILE_SECRET = 'turnstile-secret'; const allocation = vi.fn(); env.ADMISSION = { idFromName: allocation } as unknown as DurableObjectNamespace;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, hostname: 'emptypizza.github.io', action: 'wrong-action' })));
    const request = new Request('https://ppi-io.workers.dev/api/join', { method: 'POST', headers: { Origin: 'https://emptypizza.github.io', 'Content-Type': 'application/json' }, body: JSON.stringify(join()) });
    expect((await worker.fetch(request, env)).status).toBe(403); expect(allocation).not.toHaveBeenCalled();
  });
  it('checks the build, identity, sequence, finite vector and all heartbeat frames', () => {
    expect(parseJoin(join())?.nick).toBe('플레이어'); expect(parseJoin({ ...join(), nick: '<script>' })).toBeNull(); expect(parseJoin({ ...join(), build: 'old' })).toBeNull();
    const input = { type: 'input', seq: 1, dx: 1, dy: 0, aim: 0, attack: false, firePressed: false, sprint: false };
    expect(parseInput(input)).toEqual(input); expect(parseInput({ ...input, dx: 3 })).toBeNull(); expect(parseInput({ ...input, aim: NaN })).toBeNull(); expect(parseInput({ ...input, seq: -1 })).toBeNull();
    const rate = createRateState(now); for (let i = 0; i < 3; i++) expect(acceptFrame(rate, now)).toBe(true);
    expect(acceptFrame(rate, now)).toBe(false); expect(acceptFrame(rate, now + 99)).toBe(false);
    expect(acceptFrame(rate, now + 100)).toBe(true); expect(acceptFrame(rate, now + 100)).toBe(false);
  });
  it('accepts a 10Hz producer with jitter and coalesced arrivals', () => {
    const rate = createRateState(now);
    const jitter = [0, 70, -50, 40, -65, 55, -35, 20, -70, 60];
    const arrivals = Array.from({ length: 900 }, (_, i) => now + i * 100 + jitter[i % jitter.length]).sort((a, b) => a - b);
    for (const arrival of arrivals) expect(acceptFrame(rate, arrival)).toBe(true);
  });
  it('rejects sustained 20Hz input and permits at most 903 frames over 90 seconds', () => {
    const fast = createRateState(now); let rejected = 0;
    for (let i = 0; i < 100; i++) if (!acceptFrame(fast, now + i * 50)) rejected++;
    expect(rejected).toBeGreaterThan(40);
    const maximum = createRateState(now); let accepted = 0;
    for (let elapsed = 0; elapsed <= 90_000; elapsed++) while (acceptFrame(maximum, now + elapsed)) accepted++;
    expect(accepted).toBe(903);
  });
  it('stops reading oversized chunked request bodies by bytes', async () => {
    const chunks = [new Uint8Array(2048), new Uint8Array(2048), new Uint8Array(2048)]; let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { const chunk = chunks.shift(); if (chunk) controller.enqueue(chunk); else controller.close(); }, cancel() { cancelled = true; } });
    const request = new Request('https://worker/api/join', { method: 'POST', body, duplex: 'half' } as RequestInit);
    expect(await readLimitedText(request, 4096)).toBeNull(); expect(cancelled).toBe(true);
  });
});

describe('single persisted coordinator', () => {
  it('serializes 25 competing reservations into only 20 slots and exactly two fixed room names', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const { state, values } = memoryState(); const { env, roomFetch } = environment(); const coordinator = new AdmissionDO(state, env);
    const results = await Promise.all(Array.from({ length: 25 }, () => coordinator.fetch(joinRequest())));
    expect(results.filter(r => r.ok)).toHaveLength(20); expect(results.filter(r => r.status === 503)).toHaveLength(5); expect(roomFetch).toHaveBeenCalledTimes(20);
    const ledger = values.get('ledger') as ReturnType<typeof freshLedger>;
    expect(ledger.leases.map(lease => lease.roomId)).toEqual(['room-1', 'room-2']); expect(ledger.leases.map(lease => lease.seats)).toEqual([10, 10]); expect(ledger.admission).toBe(1200); expect(ledger.duration).toBe(24);
    const reply = await results[0].json() as { ticket: string; deadline: number; wsUrl: string };
    expect(reply.deadline).toBe(now + 90_000); expect(reply.wsUrl).toContain('/api/ws?ticket=');
    expect((await verifyClaims(reply.ticket, secret, now))?.playerId).toBe(0);
  });
  it('does not refund a failed room reservation and deduplicates a successful request', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const { state, values } = memoryState(); const { env, roomFetch } = environment(); const coordinator = new AdmissionDO(state, env);
    const body = join(); const first = await coordinator.fetch(joinRequest(body)); const second = await coordinator.fetch(joinRequest(body));
    expect(await first.json()).toEqual(await second.json()); expect(roomFetch).toHaveBeenCalledTimes(1);
    expect((values.get('ledger') as ReturnType<typeof freshLedger>).admission).toBe(60);
    roomFetch.mockImplementation(async () => Response.json({ reason: 'closed' }, { status: 409 }));
    expect((await coordinator.fetch(joinRequest())).status).toBe(503);
    expect((values.get('ledger') as ReturnType<typeof freshLedger>).admission).toBe(180);
  });
  it('persists an admission pause across coordinator reconstruction without blocking existing room proxying', async () => {
    const { state, values } = memoryState(); const { env } = environment(); const coordinator = new AdmissionDO(state, env);
    await coordinator.fetch(new Request('https://worker/api/admin', { method: 'POST', body: JSON.stringify({ online: false }) }));
    const replacement = new AdmissionDO(state, env);
    expect((await replacement.fetch(joinRequest())).status).toBe(503); expect((values.get('ledger') as ReturnType<typeof freshLedger>).paused).toBe(true);
    const status = await (await replacement.fetch(new Request('https://worker/api/admin'))).json() as { online: boolean; resetAt: number };
    expect(status.online).toBe(false); expect(status.resetAt).toBeGreaterThan(Date.now());
  });
});

describe('room persisted lifecycle and loss of ephemeral simulation', () => {
  it('expires an unused reservation after five seconds and reuses the ended room before its old deadline', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const { state } = memoryState(); const { env } = environment(); const room = new RoomDO(state, env);
    const oldLease: Lease = { roomId: 'room-1', generation: 1, matchId: 'room-1-1-expired', reservedAt: now, deadline: now + 90_000, seats: 1, closed: false };
    const reserve = (lease: Lease, nonce: string) => room.fetch(new Request('https://room/reserve', { method: 'POST', body: JSON.stringify({ lease, player: { id: 0, nick: '나', color: '#00BFFF', bot: false }, nonce }) }));
    expect((await reserve(oldLease, 'old-reservation-nonce-long')).ok).toBe(true);
    vi.setSystemTime(now + 5001);
    const status = await (await room.fetch(new Request('https://room/status'))).json() as { phase: string; occupied: number };
    expect(status.phase).toBe('ended'); expect(status.occupied).toBe(0);
    const newLease = { ...oldLease, generation: 2, matchId: 'room-1-2-reuse', reservedAt: now + 5001, deadline: now + 95_001 };
    expect((await reserve(newLease, 'new-reservation-nonce-long')).ok).toBe(true);
    const oldTicket = await signClaims({ v: 1, kind: 'ticket', roomId: oldLease.roomId, generation: 1, matchId: oldLease.matchId, playerId: 0, nonce: 'old-reservation-nonce-long', deadline: oldLease.deadline, expiresAt: oldLease.deadline + LIMITS.resultMs }, secret);
    expect((await room.fetch(new Request(`https://room/socket?ticket=${oldTicket}`, { headers: { Upgrade: 'websocket' } }))).status).toBe(410);
  });
  it('preserves a final personal result across memory loss and binds retrieval to its reservation nonce', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const { state, values } = memoryState(); const { env } = environment(); const first = new RoomDO(state, env);
    const lease: Lease = { roomId: 'room-1', generation: 1, matchId: 'room-1-1-personal', reservedAt: now, deadline: now + 90_000, seats: 1, closed: false };
    const nonce = 'personal-final-nonce-long';
    await first.fetch(new Request('https://room/reserve', { method: 'POST', body: JSON.stringify({ lease, player: { id: 0, nick: '나', color: '#00BFFF', bot: false }, nonce }) }));
    values.set(`player:${lease.matchId}:0`, { player: { matchId: lease.matchId, playerId: 0, outcome: 'death', kills: 3, lootCount: 4 }, expiresAt: now + LIMITS.resultMs });
    const replacement = new RoomDO(state, env);
    const claims: Claims = { v: 1, kind: 'ticket', roomId: lease.roomId, generation: 1, matchId: lease.matchId, playerId: 0, nonce, deadline: lease.deadline, expiresAt: lease.deadline + LIMITS.resultMs };
    const request = async (nonce: string) => replacement.fetch(new Request(`https://room/result?matchId=${lease.matchId}&ticket=${await signClaims({ ...claims, nonce }, secret)}`));
    const body = await (await request(nonce)).json() as { result: { reason: string; outcomes: Record<string, string> }; player: { outcome: string; kills: number; lootCount: number } };
    expect(body.result.reason).toBe('interrupted'); expect(body.result.outcomes['0']).toBe('death'); expect(body.player).toMatchObject({ outcome: 'death', kills: 3, lootCount: 4 });
    expect((await request('another-valid-signed-but-unrelated-nonce')).status).toBe(403);
  });
  it('marks a previously reserved generation interrupted after object reconstruction and persists its authenticated result', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const { state } = memoryState(); const { env } = environment(); const first = new RoomDO(state, env);
    const lease: Lease = { roomId: 'room-1', generation: 1, matchId: 'room-1-1-loss', reservedAt: now, deadline: now + 90_000, seats: 1, closed: false };
    const nonce = 'loss-test-nonce-long-enough';
    expect((await first.fetch(new Request('https://room/reserve', { method: 'POST', body: JSON.stringify({ lease, player: { id: 0, nick: '나', color: '#00BFFF', bot: false }, nonce }) }))).ok).toBe(true);
    vi.clearAllTimers(); vi.setSystemTime(now); const replacement = new RoomDO(state, env);
    const ticket = await signClaims({ v: 1, kind: 'ticket', roomId: lease.roomId, generation: 1, matchId: lease.matchId, playerId: 0, nonce, deadline: lease.deadline, expiresAt: lease.deadline + LIMITS.resultMs }, secret);
    const response = await replacement.fetch(new Request(`https://room/result?matchId=${lease.matchId}&ticket=${ticket}`));
    const body = await response.json() as { result: { reason: string }; player: { outcome: string }; expiresAt: number };
    expect(response.status).toBe(200); expect(body.result.reason).toBe('interrupted'); expect(body.player.outcome).toBe('interrupted'); expect(body.expiresAt).toBe(now + LIMITS.resultMs);
  });
});
