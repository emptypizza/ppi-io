import { it, expect } from 'vitest';
import { assertFreeSubscriptions, assertFreeDashboardProof, assertFreeDeployment, parseDeployArgs, FREE_DASHBOARD_EVIDENCE } from '../scripts/free-plan.mjs';
it('permits a new account without paid subscriptions and explicit Free subscriptions',()=>{
  expect(assertFreeSubscriptions([])).toBe(true);
  expect(assertFreeSubscriptions([{rate_plan:{id:'workers_free'},price:0}])).toBe(true);
});
it('blocks a paid plan even during a zero-price trial and rejects ambiguous billing data',()=>{
  for (const subscriptions of [undefined,{},[{rate_plan:{id:'workers_paid',public_name:'Workers Paid'},price:0}],[{rate_plan:{id:'free'},price:5}],[{}]]) {
    expect(()=>assertFreeSubscriptions(subscriptions)).toThrow();
  }
});
it('rejects a truncated subscription page using the documented total_count metadata',()=>{
  expect(()=>assertFreeSubscriptions([], {page:1,per_page:100,total_count:1})).toThrow('불완전');
  expect(()=>assertFreeSubscriptions([{rate_plan:{id:'free'}}], {page:2,total_count:1})).toThrow('불완전');
  expect(assertFreeSubscriptions([], {page:1,per_page:100,total_count:0})).toBe(true);
});

const accountId = 'd2f4ef348ab82ec11fd5ef56f9014271';
const now = Date.parse('2026-11-08T01:00:00.000Z');
const validProof = () => ({
  type: 'cloudflare-dashboard', accountId, plan: 'free', currentPlan: true,
  url: `https://dash.cloudflare.com/${accountId}/workers/plans`,
  observedAt: new Date(now).toISOString(), evidence: FREE_DASHBOARD_EVIDENCE
});

it('accepts fresh exact-account dashboard evidence only up to fifteen minutes old', () => {
  expect(assertFreeDashboardProof(validProof(), accountId, now)).toBe(true);
  expect(assertFreeDashboardProof({ ...validProof(), observedAt: new Date(now - 900000).toISOString() }, accountId, now)).toBe(true);
  for (const observedAt of [new Date(now - 900001).toISOString(), new Date(now + 1).toISOString(), 'invalid', '2026-11-08']) {
    expect(() => assertFreeDashboardProof({ ...validProof(), observedAt }, accountId, now)).toThrow();
  }
});

it('rejects mismatched, incomplete, or ambiguous dashboard evidence', () => {
  for (const update of [
    { type: 'screenshot' }, { accountId: '0'.repeat(32) }, { plan: 'paid' }, { currentPlan: false },
    { currentPlan: 'true' }, { url: `https://dash.cloudflare.com/${accountId}/workers/plans/` },
    { url: `https://dash.cloudflare.com/${accountId}/workers/plans?free=true` },
    { evidence: 'Free $0 Upgrade' }, { evidence: '' }, { observedAt: null }, { extra: 'ignored' }
  ]) expect(() => assertFreeDashboardProof({ ...validProof(), ...update }, accountId, now)).toThrow();
  const missing = validProof(); delete missing.evidence;
  for (const proof of [missing, undefined, null, [], {}]) {
    expect(() => assertFreeDashboardProof(proof, accountId, now)).toThrow();
  }
});

it('keeps the successful subscription API authoritative even when valid dashboard evidence exists', () => {
  const args = { apiSucceeded: true, proof: validProof(), accountId, now };
  expect(assertFreeDeployment({ ...args, subscriptions: [] })).toBe('subscriptions');
  for (const subscriptions of [undefined, [{ rate_plan: { id: 'workers_paid' }, price: 0 }], [{ rate_plan: { id: 'free' }, price: 5 }]]) {
    expect(() => assertFreeDeployment({ ...args, subscriptions })).toThrow();
  }
  expect(() => assertFreeDeployment({ ...args, subscriptions: [], pageInfo: { total_count: 1 } })).toThrow();
});

it('requires explicit valid dashboard evidence after an API failure', () => {
  expect(() => assertFreeDeployment({ apiSucceeded: false, accountId, now })).toThrow();
  expect(assertFreeDeployment({ apiSucceeded: false, proof: validProof(), accountId, now })).toBe('cloudflare-dashboard');
  expect(() => assertFreeDeployment({ apiSucceeded: false, proof: { ...validProof(), plan: 'paid' }, accountId, now })).toThrow();
});

it('parses the explicit proof option without accepting skip flags or missing paths', () => {
  expect(parseDeployArgs(['--check', '--free-plan-proof', 'free-plan.local.json'])).toEqual({ check: true, open: false, freePlanProof: 'free-plan.local.json' });
  expect(parseDeployArgs(['--free-plan-proof', 'free-plan.local.json', '--open']).open).toBe(true);
  for (const args of [['--skip'], ['--free-plan-proof'], ['--free-plan-proof', '--open'], ['--free-plan-proof', 'proof.json'], ['--free-plan-proof', 'a.local.json', '--free-plan-proof', 'b.local.json']]) {
    expect(() => parseDeployArgs(args)).toThrow();
  }
});
