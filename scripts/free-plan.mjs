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

export const FREE_DASHBOARD_EVIDENCE = 'Free | $0 | For personal use and simple applications | Current plan';
const proofKeys = ['type', 'accountId', 'plan', 'currentPlan', 'url', 'observedAt', 'evidence'];
const proofMaxAgeMs = 15 * 60 * 1000;

export function assertFreeDashboardProof(proof, accountId, now = Date.now()) {
  const invalid = () => { throw new Error('최신 Workers Free 대시보드 확인 증거가 유효하지 않습니다. 배포를 중단합니다.'); };
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)
    || Object.keys(proof).length !== proofKeys.length
    || !proofKeys.every(key => Object.hasOwn(proof, key))
    || typeof accountId !== 'string' || !/^[a-f0-9]{32}$/.test(accountId)
    || proof.type !== 'cloudflare-dashboard' || proof.accountId !== accountId
    || proof.plan !== 'free' || proof.currentPlan !== true
    || proof.url !== `https://dash.cloudflare.com/${accountId}/workers/plans`
    || proof.evidence !== FREE_DASHBOARD_EVIDENCE
    || typeof proof.observedAt !== 'string' || !Number.isFinite(now)) invalid();
  const observed = Date.parse(proof.observedAt);
  if (!Number.isFinite(observed) || new Date(observed).toISOString() !== proof.observedAt
    || observed > now || now - observed > proofMaxAgeMs) invalid();
  return true;
}

export function assertFreeDeployment({ apiSucceeded, subscriptions, pageInfo, proof, accountId, now }) {
  // A successful API response always wins: paid, ambiguous, or partial data cannot use the fallback.
  if (apiSucceeded === true) {
    assertFreeSubscriptions(subscriptions, pageInfo);
    return 'subscriptions';
  }
  if (proof === undefined) throw new Error('계정 구독 조회가 거부되었습니다. Free 확인 전 배포하지 않습니다.');
  assertFreeDashboardProof(proof, accountId, now);
  return 'cloudflare-dashboard';
}

export function parseDeployArgs(args) {
  const options = { check: false, open: false, freePlanProof: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--check') options.check = true;
    else if (arg === '--open') options.open = true;
    else if (arg === '--free-plan-proof') {
      const path = args[++i];
      if (options.freePlanProof !== null || typeof path !== 'string' || path.startsWith('--') || !path.endsWith('.local.json')) {
        throw new Error('--free-plan-proof에는 Git에서 무시되는 *.local.json 파일 하나를 지정하세요.');
      }
      options.freePlanProof = path;
    } else throw new Error('지원 인자: --check, --open, --free-plan-proof <*.local.json>');
  }
  return options;
}
