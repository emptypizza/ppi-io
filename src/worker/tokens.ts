import { ROOM_IDS } from './budget';
export interface Claims { v: 1; kind: 'ticket' | 'resume'; roomId: string; generation: number; matchId: string; playerId: number; nonce: string; deadline: number; expiresAt: number }
const encoder = new TextEncoder();
function b64(bytes: Uint8Array): string { let binary = ''; for (const value of bytes) binary += String.fromCharCode(value); return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function unb64(value: string): Uint8Array<ArrayBuffer> { const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, character => character.charCodeAt(0)); }
async function key(secret: string) { if (secret.length < 32) throw new Error('Signing secret is not configured'); return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
export async function signClaims(claims: Claims, secret: string): Promise<string> {
  const payload = b64(encoder.encode(JSON.stringify(claims)));
  return payload + '.' + b64(new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(payload))));
}
export async function verifyClaims(token: string, secret: string, now = Date.now()): Promise<Claims | null> {
  try {
    if (token.length > 4096 || !/^[\w-]+\.[\w-]+$/.test(token)) return null;
    const [payload, signature] = token.split('.');
    if (!(await crypto.subtle.verify('HMAC', await key(secret), unb64(signature), encoder.encode(payload)))) return null;
    const value = JSON.parse(new TextDecoder().decode(unb64(payload))) as Claims;
    if (value.v !== 1 || !['ticket', 'resume'].includes(value.kind) || !(ROOM_IDS as readonly string[]).includes(value.roomId)
      || !Number.isSafeInteger(value.generation) || value.generation < 1 || !Number.isInteger(value.playerId) || value.playerId < 0 || value.playerId >= 10
      || typeof value.matchId !== 'string' || value.matchId.length > 100 || typeof value.nonce !== 'string' || value.nonce.length < 16
      || !Number.isFinite(value.deadline) || !Number.isFinite(value.expiresAt) || value.expiresAt <= now || value.deadline > value.expiresAt) return null;
    return value;
  } catch { return null; }
}
