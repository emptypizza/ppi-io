export function assertFreeSubscriptions(subscriptions, pageInfo = {}) {
  if (!Array.isArray(subscriptions)) throw new Error('Cloudflare 구독 정보를 확인할 수 없습니다. 배포를 중단합니다.');
  const total = pageInfo.total_count;
  if ((total !== undefined && (!Number.isSafeInteger(total) || total !== subscriptions.length))
    || (pageInfo.page !== undefined && pageInfo.page !== 1)
    || (pageInfo.total_pages !== undefined && pageInfo.total_pages !== 1)
    || (total === undefined && pageInfo.per_page !== undefined && subscriptions.length >= pageInfo.per_page)) {
    throw new Error('구독 목록이 불완전합니다. 전체 무료 상태 확인 전 배포하지 않습니다.');
  }
  for (const subscription of subscriptions) {
    const plan = subscription.rate_plan;
    const id = String(plan?.id || '');
    const name = String(plan?.public_name || plan?.name || '');
    const explicitlyFree = /^(free|workers[_-]free)$/i.test(id) || /^(cloudflare\s+)?(workers\s+)?free(\s+plan)?$/i.test(name);
    if (!explicitlyFree || Number(subscription.price || 0) > 0) {
      throw new Error('무료 플랜만 사용하는 계정임을 확인하지 못했습니다. 유료 전환 없이 배포를 중단합니다.');
    }
  }
  return true;
}
