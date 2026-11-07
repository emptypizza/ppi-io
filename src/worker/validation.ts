import { BUILD_ID, COLORS, PROTOCOL_VERSION, type InputFrame, type JoinRequest } from '../shared/protocol';
export function parseJoin(value: unknown): JoinRequest | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  if (body.protocol !== PROTOCOL_VERSION || body.build !== BUILD_ID || typeof body.nick !== 'string'
    || typeof body.color !== 'string' || !(COLORS as readonly string[]).includes(body.color)
    || typeof body.challengeToken !== 'string' || body.challengeToken.length > 2048
    || typeof body.requestId !== 'string' || !/^[\w-]{8,80}$/.test(body.requestId)) return null;
  const nick = body.nick.trim().normalize('NFC');
  if (!nick || [...nick].length > 12 || /[<>\u0000-\u001f\u007f-\u009f]/u.test(nick)) return null;
  return { protocol: PROTOCOL_VERSION, build: BUILD_ID, nick, color: body.color, challengeToken: body.challengeToken, requestId: body.requestId };
}
export function parseInput(value: unknown): InputFrame | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (input.type !== 'input' || !Number.isSafeInteger(input.seq) || (input.seq as number) < 0
    || !['dx', 'dy', 'aim'].every(key => typeof input[key] === 'number' && Number.isFinite(input[key]))
    || Math.abs(input.dx as number) > 1 || Math.abs(input.dy as number) > 1 || Math.abs(input.aim as number) > Math.PI * 2
    || !['attack', 'firePressed', 'sprint'].every(key => typeof input[key] === 'boolean')) return null;
  return { type: 'input', seq: input.seq as number, dx: input.dx as number, dy: input.dy as number, aim: input.aim as number, attack: input.attack as boolean, firePressed: input.firePressed as boolean, sprint: input.sprint as boolean };
}
export interface RateState { tokens: number; lastAt: number }
export const createRateState = (now: number): RateState => ({ tokens: 3, lastAt: now });
/** Ten frames per second with three frames of network jitter tolerance, including duplicates/heartbeats. */
export function acceptFrame(state: RateState, now: number): boolean {
  state.tokens = Math.min(3, state.tokens + Math.max(0, now - state.lastAt) / 100);
  state.lastAt = Math.max(state.lastAt, now);
  if (state.tokens + 1e-9 < 1) return false;
  state.tokens = Math.max(0, state.tokens - 1); return true;
}
export const NEUTRAL = Object.freeze({ dx: 0, dy: 0, aim: 0, attack: false, firePressed: false, sprint: false });
/** Bound bytes while streaming, including chunked requests without Content-Length. */
export async function readLimitedText(request: Request, maxBytes: number): Promise<string | null> {
  if (Number(request.headers.get('Content-Length') || 0) > maxBytes) return null;
  if (!request.body) return '';
  const reader = request.body.getReader(); const decoder = new TextDecoder(); let size = 0; let text = '';
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); return null; }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}
