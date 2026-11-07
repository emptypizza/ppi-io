import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertFreeSubscriptions } from './free-plan.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
const args = process.argv.slice(2);
if (args.some(a => !['--check', '--open'].includes(a))) throw new Error('지원 인자: --check, --open');
function authJson(command) {
  try { return JSON.parse(execFileSync(process.execPath, [wrangler, ...command, '--json'], { cwd: root, env, encoding: 'utf8', stdio:['ignore','pipe','pipe'] })); }
  catch { throw new Error('Cloudflare 로그인이 필요합니다. 먼저 npx wrangler login을 실행하세요. 인증 정보는 출력하지 않습니다.'); }
}
try {
  const who = authJson(['whoami']);
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || (who.accounts?.length === 1 ? who.accounts[0].id : null);
  if (!accountId) throw new Error('대상 무료 계정을 CLOUDFLARE_ACCOUNT_ID로 지정하세요.');
  const auth = authJson(['auth','token']);
  if (!auth.token) throw new Error('Cloudflare 토큰을 확인할 수 없습니다.');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/subscriptions?per_page=100`, { headers: { Authorization: `Bearer ${auth.token}` } });
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error('계정 구독 조회가 거부되었습니다. Free 확인 전 배포하지 않습니다.');
  assertFreeSubscriptions(body.result, body.result_info);
  console.log('무료 계정 구독 검사 통과. 유료 업그레이드를 수행하지 않습니다.');
  if (!args.includes('--check')) {
    const vars = JSON.parse(readFileSync(new URL('../public/config.json', import.meta.url), 'utf8'));
    if (args.includes('--open') && (!vars.apiUrl?.startsWith('https://') || !vars.turnstileSiteKey)) throw new Error('온라인 개방 전 HTTPS API 주소와 Turnstile sitekey를 설정하세요.');
    const result = spawnSync(process.execPath, [wrangler,'deploy','--var',`ONLINE_ENABLED:${args.includes('--open') ? 'true' : 'false'}`], {cwd:root,env:{...env,CLOUDFLARE_ACCOUNT_ID:accountId},stdio:'inherit'});
    process.exitCode = result.status ?? 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
