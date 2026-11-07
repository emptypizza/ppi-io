import { it, expect } from 'vitest';
import { assertFreeSubscriptions } from '../scripts/free-plan.mjs';
it('permits a new account without paid subscriptions and explicit Free subscriptions',()=>{
  expect(assertFreeSubscriptions([])).toBe(true);
  expect(assertFreeSubscriptions([{rate_plan:{id:'workers_free'},price:0}])).toBe(true);
});
it('blocks a paid plan even during a zero-price trial and rejects ambiguous billing data',()=>{
  for (const subscriptions of [undefined,{},[{rate_plan:{id:'workers_paid',public_name:'Workers Paid'},price:0}],[{rate_plan:{id:'free'},price:5}],[{}]]) {
    expect(()=>assertFreeSubscriptions(subscriptions)).toThrow();
  }
});
