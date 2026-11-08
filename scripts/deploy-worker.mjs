import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, relative, isAbsolute } from 'node:path';
import { assertFreeDeployment, parseDeployArgs } from './free-plan.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
function authJson(command) {
  try { return JSON.parse(execFileSync(process.execPath, [wrangler, ...command, '--json'], { cwd: root, env, encoding: 'utf8', stdio:['ignore','pipe','pipe'] })); }
  catch { throw new Error('Cloudflare 로그인이 필요합니다. 먼저 npx wrangler login을 실행하세요. 인증 정보는 출력하지 않습니다.'); }
}
function readDashboardProof(path) {
  const fullPath = resolve(root, path);
  const localPath = relative(root, fullPath);
  if (localPath.startsWith('..') || isAbsolute(localPath) || !fullPath.endsWith('.local.json')) {
    throw new Error('대시보드 확인 증거는 저장소 안의 무시되는 *.local.json 파일이어야 합니다.');
  }
  try {
    execFileSync('git', ['check-ignore', '--quiet', '--', localPath], { cwd: root, stdio: 'ignore' });
  } catch {
    throw new Error('대시보드 확인 증거가 Git에서 무시되지 않습니다. 배포를 중단합니다.');
  }
  try { return JSON.parse(readFileSync(fullPath, 'utf8')); }
  catch { throw new Error('대시보드 확인 증거 JSON을 읽을 수 없습니다. 배포를 중단합니다.'); }
}
try {
  const options = parseDeployArgs(process.argv.slice(2));
  const who = authJson(['whoami']);
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || (who.accounts?.length === 1 ? who.accounts[0].id : null);
  if (!accountId) throw new Error('대상 무료 계정을 CLOUDFLARE_ACCOUNT_ID로 지정하세요.');
  const auth = authJson(['auth','token']);
  if (!auth.token) throw new Error('Cloudflare 토큰을 확인할 수 없습니다.');
  let body;
  let apiSucceeded = false;
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/subscriptions?per_page=100`, { headers: { Authorization: `Bearer ${auth.token}` } });
    body = await response.json();
    apiSucceeded = response.ok && body?.success === true;
  } catch { /* API transport/format failures require explicit fresh dashboard evidence. */ }
  const proof = !apiSucceeded && options.freePlanProof ? readDashboardProof(options.freePlanProof) : undefined;
  const verifiedBy = assertFreeDeployment({ apiSucceeded, subscriptions: body?.result, pageInfo: body?.result_info, proof, accountId });
  console.log(verifiedBy === 'subscriptions'
    ? '무료 계정 구독 검사 통과. 유료 업그레이드를 수행하지 않습니다.'
    : '최신 Workers Free 대시보드 확인 증거 검사 통과. 유료 업그레이드를 수행하지 않습니다.');
  if (!options.check) {
    const vars = JSON.parse(readFileSync(new URL('../public/config.json', import.meta.url), 'utf8'));
    if (options.open && (!vars.apiUrl?.startsWith('https://') || !vars.turnstileSiteKey)) throw new Error('온라인 개방 전 HTTPS API 주소와 Turnstile sitekey를 설정하세요.');
    const result = spawnSync(process.execPath, [wrangler,'deploy','--var',`ONLINE_ENABLED:${options.open ? 'true' : 'false'}`], {cwd:root,env:{...env,CLOUDFLARE_ACCOUNT_ID:accountId},stdio:'inherit'});
    process.exitCode = result.status ?? 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
