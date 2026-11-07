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
it('rejects a truncated subscription page using the documented total_count metadata',()=>{
  expect(()=>assertFreeSubscriptions([], {page:1,per_page:100,total_count:1})).toThrow('불완전');
  expect(()=>assertFreeSubscriptions([{rate_plan:{id:'free'}}], {page:2,total_count:1})).toThrow('불완전');
  expect(assertFreeSubscriptions([], {page:1,per_page:100,total_count:0})).toBe(true);
});
