import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { SELF, evictDurableObject, listDurableObjectIds, reset, runInDurableObject } from 'cloudflare:test';
import worker, { type Env } from '../src/worker/index';
import { BUILD_ID, PROTOCOL_VERSION, type JoinReply, type ServerMessage } from '../src/shared/protocol';
import { GameSim } from '../src/shared/simulation';
import { LIMITS, freshLedger, type Ledger } from '../src/worker/budget';

const bindings = env as unknown as Env;
const origin = 'http://localhost';
const clients: WebSocket[] = [];
interface RoomHarness {
  ready: Promise<void>;
  timer: ReturnType<typeof setInterval> | null;
  meta: { matchId: string; generation: number; phase: string; lobbyEndsAt: number | null; deadline: number; members: Array<{ identity: { id: number }; ticketExpiresAt: number }> };
  sim: GameSim | null;
  lastScheduler: number;
  sessions: Map<number, { seq: number; input: unknown }>;
  step(): Promise<void>;
}
interface AdmissionHarness { ready: Promise<void>; ledger: Ledger }
const roomStub = (roomId: string) => bindings.ROOMS.get(bindings.ROOMS.idFromName(roomId));
const admissionStub = () => bindings.ADMISSION.get(bindings.ADMISSION.idFromName('admission-v1'));
async function join(nick = 'PLAYER'): Promise<{ response: Response; reply: JoinReply }> {
  const response = await SELF.fetch('http://localhost/api/join', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: PROTOCOL_VERSION, build: BUILD_ID, nick, color: '#00BFFF', challengeToken: '', requestId: crypto.randomUUID() }) });
  return { response, reply: await response.json() as JoinReply };
}
async function connect(url: string) {
  const response = await SELF.fetch(url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:'), { headers: { Origin: origin, Upgrade: 'websocket' } });
  const messages: ServerMessage[] = [];
  const socket = response.webSocket;
  if (socket) {
    clients.push(socket); socket.addEventListener('message', event => { messages.push(JSON.parse(String(event.data)) as ServerMessage); }); socket.accept();
  }
  return { response, socket, messages };
}
async function waitMessage<T extends ServerMessage['type']>(messages: ServerMessage[], type: T): Promise<Extract<ServerMessage, { type: T }>> {
  for (let i = 0; i < 100; i++) {
    const message = messages.find(message => message.type === type);
    if (message) return message as Extract<ServerMessage, { type: T }>;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`No ${type} message received`);
}
async function startRoom(reply: JoinReply) {
  await runInDurableObject(roomStub(reply.roomId), async instance => {
    const room = instance as unknown as RoomHarness; await room.ready;
    if (room.timer) clearInterval(room.timer); room.timer = null;
    if (room.meta.phase === 'lobby') { room.meta.lobbyEndsAt = Date.now() - 1; room.lastScheduler = Date.now(); await room.step(); }
  });
}

beforeEach(async () => { await reset(); });
afterEach(async () => { for (const socket of clients.splice(0)) { try { socket.close(); } catch {} } await reset(); });

describe('actual workerd admission and WebSockets', () => {
  it('rejects invalid origin, malformed joins and forged tickets before creating a DO', async () => {
    const badOrigin = await SELF.fetch('http://localhost/api/join', { method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body: '{}' });
    expect(badOrigin.status).toBe(403);
    const invalidJoin = await SELF.fetch('http://localhost/api/join', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
    expect(invalidJoin.status).toBe(400);
    const forged = await SELF.fetch('http://localhost/api/ws?ticket=not.a-signature', { headers: { Origin: origin, Upgrade: 'websocket' } });
    expect(forged.status).toBe(401);
    expect(await listDurableObjectIds(bindings.ADMISSION)).toHaveLength(0);
    expect(await listDurableObjectIds(bindings.ROOMS)).toHaveLength(0);
  });

  it('opens two independent player sockets and starts one shared ten-slot simulation', async () => {
    const first = await join('ONE'), second = await join('TWO');
    expect(first.response.status).toBe(200); expect(second.reply.matchId).toBe(first.reply.matchId);
    const a = await connect(first.reply.wsUrl), b = await connect(second.reply.wsUrl);
    expect(a.response.status).toBe(101); expect(b.response.status).toBe(101);
    const wa = await waitMessage(a.messages, 'welcome'), wb = await waitMessage(b.messages, 'welcome');
    expect(wa.playerId).not.toBe(wb.playerId); expect(wa.matchId).toBe(wb.matchId);
    await startRoom(first.reply);
    const sa = await waitMessage(a.messages, 'start'), sb = await waitMessage(b.messages, 'start');
    expect(sa.snapshot).toEqual(sb.snapshot); expect(sa.map).toEqual(sb.map);
    expect(sa.roster).toHaveLength(10); expect(sa.roster.filter(player => !player.bot)).toHaveLength(2);
    expect(sa.roster.filter(player => player.bot)).toHaveLength(8);
  });

  it('limits connected players to two rooms and rejects the twenty-first admission', async () => {
    const rooms = new Map<string, number>();
    for (let i = 0; i < 20; i++) {
      const admission = await join(`P${i}`); expect(admission.response.status).toBe(200);
      const client = await connect(admission.reply.wsUrl); expect(client.response.status).toBe(101);
      await waitMessage(client.messages, 'welcome');
      rooms.set(admission.reply.roomId, (rooms.get(admission.reply.roomId) || 0) + 1);
    }
    expect([...rooms.values()].sort()).toEqual([10, 10]);
    const extra = await join('EXTRA'); expect(extra.response.status).toBe(503);
    expect((extra.reply as unknown as { reason: string }).reason).toMatch(/full|capacity/);
    expect(await listDurableObjectIds(bindings.ROOMS)).toHaveLength(2);
    for (const id of rooms.keys()) {
      const connected = await runInDurableObject(roomStub(id), async instance => {
        const room = instance as unknown as RoomHarness; await room.ready; return room.sessions.size;
      });
      expect(connected).toBe(10);
    }
  });

  it('reserves no room or ticket capacity when the durable daily budget is exhausted', async () => {
    const beforeRooms = (await listDurableObjectIds(bindings.ROOMS)).map(id => id.toString()).sort();
    await runInDurableObject(admissionStub(), async (instance, state) => {
      const admission = instance as unknown as AdmissionHarness; await admission.ready;
      admission.ledger = freshLedger(Date.now()); admission.ledger.admission = LIMITS.admission;
      await state.storage.put('ledger', admission.ledger);
    });
    const admission = await join(); expect(admission.response.status).toBe(503);
    expect((admission.reply as unknown as { reason: string }).reason).toBe('daily_budget_exhausted');
    expect((await listDurableObjectIds(bindings.ROOMS)).map(id => id.toString()).sort()).toEqual(beforeRooms);
    const ledger = await runInDurableObject(admissionStub(), async (instance, state) => {
      const object = instance as unknown as AdmissionHarness; await object.ready; return state.storage.get<Ledger>('ledger');
    });
    expect(ledger?.admission).toBe(LIMITS.admission); expect(ledger?.duration).toBe(0); expect(ledger?.leases).toHaveLength(0);
  });

  it('accepts a valid resume by replacing a connection whose close has not reached the server', async () => {
    const admission = await join(), original = await connect(admission.reply.wsUrl);
    const welcome = await waitMessage(original.messages, 'welcome');
    const url = new URL('http://localhost/api/ws'); url.searchParams.set('resume', welcome.resumeToken);
    const resumed = await connect(url.toString()); expect(resumed.response.status).toBe(101);
    const replacement = await waitMessage(resumed.messages, 'welcome');
    expect(replacement.playerId).toBe(welcome.playerId); expect(replacement.resumeToken).not.toBe(welcome.resumeToken);
    const count = await runInDurableObject(roomStub(admission.reply.roomId), async instance => {
      const room = instance as unknown as RoomHarness; await room.ready; return room.sessions.size;
    });
    expect(count).toBe(1);
    const stale = await connect(url.toString()); expect(stale.response.status).toBeGreaterThanOrEqual(400);
  });

  it('preserves an already issued personal death result across DO eviction', async () => {
    const a = await join('ONE'), b = await join('TWO');
    const ca = await connect(a.reply.wsUrl), cb = await connect(b.reply.wsUrl);
    const wa = await waitMessage(ca.messages, 'welcome'); await waitMessage(cb.messages, 'welcome');
    await startRoom(a.reply);
    await runInDurableObject(roomStub(a.reply.roomId), async instance => {
      const room = instance as unknown as RoomHarness; await room.ready;
      room.sim!.entity(wa.playerId)!.takeDamage(10000, null); room.lastScheduler = Date.now(); await room.step();
      if (room.timer) clearInterval(room.timer); room.timer = null;
    });
    const personal = await waitMessage(ca.messages, 'player_result'); expect(personal.outcome).toBe('death');
    await evictDurableObject(roomStub(a.reply.roomId));
    const resultUrl = new URL('http://localhost/api/result'); resultUrl.searchParams.set('resume', wa.resumeToken); resultUrl.searchParams.set('matchId', wa.matchId);
    const response = await SELF.fetch(resultUrl, { headers: { Origin: origin } });
    expect(response.status).toBe(200);
    const result = await response.json() as { player: { outcome: string }; result: { reason: string } };
    expect(result.player.outcome).toBe('death'); expect(result.result.reason).toBe('interrupted');
  });

  it('reuses a finished room immediately with a new generation while keeping the previous result', async () => {
    const previous = await join(), connection = await connect(previous.reply.wsUrl);
    const welcome = await waitMessage(connection.messages, 'welcome'); await startRoom(previous.reply);
    await runInDurableObject(roomStub(previous.reply.roomId), async instance => {
      const room = instance as unknown as RoomHarness; await room.ready;
      room.sim!.interrupt(); room.lastScheduler = Date.now(); await room.step();
    });
    await waitMessage(connection.messages, 'match_result');
    const next = await join('NEXT'); expect(next.response.status).toBe(200);
    expect(next.reply.roomId).toBe(previous.reply.roomId); expect(next.reply.generation).toBe(previous.reply.generation + 1);
    expect(next.reply.matchId).not.toBe(previous.reply.matchId); expect(Date.now()).toBeLessThan(previous.reply.deadline);
    const stale = await connect(previous.reply.wsUrl); expect(stale.response.status).toBe(410);
    const url = new URL('http://localhost/api/result'); url.searchParams.set('resume', welcome.resumeToken); url.searchParams.set('matchId', welcome.matchId);
    const result = await SELF.fetch(url, { headers: { Origin: origin } }); expect(result.status).toBe(200);
    expect((await result.json() as { player: { outcome: string } }).player.outcome).toBe('interrupted');
  });

  it('reclaims an unused slot without allowing the old ticket to read the replacement player result', async () => {
    const unused = await join('UNUSED'), keeper = await join('KEEPER');
    const keeping = await connect(keeper.reply.wsUrl); await waitMessage(keeping.messages, 'welcome');
    await runInDurableObject(roomStub(unused.reply.roomId), async (instance, state) => {
      const room = instance as unknown as RoomHarness; await room.ready;
      if (room.timer) clearInterval(room.timer); room.timer = null;
      room.meta.members.find(member => member.identity.id === 0)!.ticketExpiresAt = Date.now() - 1;
      await state.storage.put('meta', room.meta);
    });
    const replacement = await join('REPLACEMENT'); expect(replacement.response.status).toBe(200);
    expect(replacement.reply.matchId).toBe(unused.reply.matchId);
    const connected = await connect(replacement.reply.wsUrl); expect(connected.response.status).toBe(101);
    expect((await waitMessage(connected.messages, 'welcome')).playerId).toBe(0);
    const staleSocket = await connect(unused.reply.wsUrl); expect(staleSocket.response.status).toBeGreaterThanOrEqual(400);
    await startRoom(replacement.reply);
    await runInDurableObject(roomStub(replacement.reply.roomId), async instance => {
      const room = instance as unknown as RoomHarness; await room.ready;
      room.sim!.interrupt(); room.lastScheduler = Date.now(); await room.step();
    });
    const url = new URL('http://localhost/api/result'); url.searchParams.set('ticket', unused.reply.ticket); url.searchParams.set('matchId', unused.reply.matchId);
    const snoop = await SELF.fetch(url, { headers: { Origin: origin } }); expect(snoop.status).toBe(403);
  });

  it('cancels an oversized streaming body before reading its entire payload', async () => {
    const beforeAdmission = (await listDurableObjectIds(bindings.ADMISSION)).map(id => id.toString()).sort();
    let chunks = 0, cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { chunks++; controller.enqueue(new Uint8Array(1024).fill(32)); if (chunks === 20) controller.close(); },
      cancel() { cancelled = true; },
    });
    const request = new Request('http://localhost/api/join', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body });
    const response = await worker.fetch(request, bindings);
    expect(response.status).toBe(413); expect(cancelled).toBe(true); expect(chunks).toBeLessThan(20);
    expect((await listDurableObjectIds(bindings.ADMISSION)).map(id => id.toString()).sort()).toEqual(beforeAdmission);
  });
});
