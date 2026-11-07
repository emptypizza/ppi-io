export const LIMITS = Object.freeze({ admission: 60_000, ticket: 60, control: 10_000, duration: 9_000, roomDuration: 12, roomMs: 90_000, lobbyMs: 10_000, reservationMs: 5_000, resumeMs: 5_000, maxResumes: 3, resultMs: 86_400_000, seats: 10 });
export const ROOM_IDS = ['room-1', 'room-2'] as const;
export interface Lease { roomId: string; generation: number; matchId: string; reservedAt: number; deadline: number; seats: number; closed: boolean; nextPlayerId?: number }
export interface Ledger { day: string; admission: number; control: number; duration: number; paused: boolean; leases: Lease[]; generations: Record<string, number>; requests: Record<string, { roomId: string; matchId: string; playerId: number; ticket: string; deadline: number; expiresAt: number }> }
export const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);
export const resetAt = (now: number) => Date.parse(utcDay(now) + 'T00:00:00Z') + 86_400_000;
export function freshLedger(now: number): Ledger { return { day: utcDay(now), admission: 0, control: 0, duration: 0, paused: false, leases: [], generations: {}, requests: {} }; }
/** Cross-midnight active reservations are charged in both UTC days. Nothing is refunded. */
export function rollDay(ledger: Ledger, now: number): Ledger {
  const leases = ledger.leases.filter(lease => lease.deadline > now);
  const requests = Object.fromEntries(Object.entries(ledger.requests).filter(([, value]) => value.expiresAt > now));
  if (ledger.day === utcDay(now)) return { ...ledger, leases, requests };
  const midnight = Date.parse(utcDay(now) + 'T00:00:00Z');
  // The first request may arrive after a crossing match has already expired.
  const crossing = ledger.leases.filter(lease => lease.reservedAt < midnight && lease.deadline > midnight);
  return { ...ledger, day: utcDay(now), admission: crossing.reduce((total, lease) => total + lease.seats * LIMITS.ticket, 0), control: 0, duration: crossing.length * LIMITS.roomDuration, leases, requests };
}
export function canCharge(ledger: Ledger, charge: { tickets?: number; rooms?: number; controls?: number }): boolean {
  return ledger.admission + (charge.tickets || 0) * LIMITS.ticket <= LIMITS.admission
    && ledger.duration + (charge.rooms || 0) * LIMITS.roomDuration <= LIMITS.duration
    && ledger.control + (charge.controls || 0) <= LIMITS.control;
}
export function charge(ledger: Ledger, costs: { tickets?: number; rooms?: number; controls?: number }): boolean {
  if (!canCharge(ledger, costs)) return false;
  ledger.admission += (costs.tickets || 0) * LIMITS.ticket;
  ledger.duration += (costs.rooms || 0) * LIMITS.roomDuration;
  ledger.control += costs.controls || 0;
  return true;
}
