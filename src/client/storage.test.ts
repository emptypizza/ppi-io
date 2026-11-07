import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAVE_KEY, TrainingStore } from './storage';

describe('practice storage', () => {
  let values: Map<string,string>;
  beforeEach(() => {
    values = new Map();
    vi.stubGlobal('localStorage', { getItem: (key:string) => values.get(key) ?? null, setItem: (key:string,value:string) => values.set(key,value) });
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-07T04:00:00Z'));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it('preserves modern Unix timestamps and does not award offline gold on same-clock reload', () => {
    const first = new TrainingStore(); first.persist();
    const gold = first.save.gold, lastUnix = Math.floor(Date.now()/1000);
    expect(lastUnix).toBeGreaterThan(1_000_000_000);
    const second = new TrainingStore();
    expect(second.save.lastUnix).toBe(lastUnix);
    expect(second.collectOffline()).toBe(0);
    expect(second.save.gold).toBe(gold);
  });
  it('caps offline rewards at eight hours and cannot collect them twice', () => {
    const store = new TrainingStore(); store.persist();
    const expected = Math.floor(store.goldPerMinute()*8*60);
    vi.advanceTimersByTime(24*60*60*1000);
    expect(new TrainingStore().collectOffline()).toBe(expected);
    expect(new TrainingStore().collectOffline()).toBe(0);
  });
  it('leaves the original PPI save key untouched', () => {
    values.set('ppi_idle_save_v1','original-save');
    const store = new TrainingStore(); store.buy(0); store.persist();
    expect(values.get('ppi_idle_save_v1')).toBe('original-save');
    expect(values.has(SAVE_KEY)).toBe(true);
  });
});
