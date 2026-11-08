import { chromium, firefox, webkit } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const options = { browser: 'firefox', url: 'https://emptypizza.github.io/ppi-io/', output: 'output/browser-practice' };
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  if (flag === '--help') { console.log('node tests/browser-practice.mjs [--browser firefox|chromium|webkit] [--url URL] [--output DIRECTORY]'); process.exit(0); }
  if (!['--browser', '--url', '--output'].includes(flag) || !process.argv[index + 1]) throw new Error(`Unsupported argument: ${flag}`);
  options[flag.slice(2)] = process.argv[++index];
}
const engines = { chromium, firefox, webkit };
if (!engines[options.browser]) throw new Error('Unsupported browser');
const target = new URL(options.url);
if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) throw new Error('Expected a public HTTP(S) game URL');
const output = resolve(options.output);
await mkdir(output, { recursive: true });
const seed = 0x20261108;
const sentinel = 'original-ppi-save-preservation-sentinel';
const report = {
  browser: options.browser, url: target.origin + target.pathname, node: process.version,
  platform: process.platform, arch: process.arch, startedAt: new Date().toISOString(), passed: false,
  scope: 'Practice only. No online button or Turnstile interaction. Isolated save fixture; real keyboard/mouse input and the existing advanceTime hook. No simulation state injection.',
  practiceSeed: seed, pageErrors: [], consoleErrors: [], networkErrors: [], httpErrors: [],
  unexpectedOnlineActivity: [], webSockets: [], checks: {}, artifacts: [],
};
const safeUrl = value => { try { const url = new URL(value); return url.origin + url.pathname; } catch { return '[invalid URL]'; } };
const safeText = value => String(value).replace(/https?:\/\/[^\s<>"')]+/g, safeUrl).replace(/\b(ticket|resumeToken|challengeToken|authorization|secret)\s*[:=]\s*[^\s,}]+/gi, '$1=[redacted]');
const summary = state => ({
  mode: state.mode, matchMode: state.matchMode, phase: state.phase, tick: state.tick, time: state.time,
  matchId: state.matchId, myId: state.myId, humans: state.humans, bots: state.bots, connected: state.connected,
  player: state.player, practice: state.practice, ended: state.ended,
  result: state.result && { reason: state.result.reason, winnerId: state.result.winnerId, outcome: state.result.outcomes?.[String(state.myId)] },
});
let browser, page, collecting = true;
const saveReport = () => writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2));
const readState = () => page.evaluate(() => JSON.parse(window.render_game_to_text()));
const readSave = () => page.evaluate(() => JSON.parse(localStorage.getItem('ppi_io_save_v1')));
const advance = milliseconds => page.evaluate(ms => window.advanceTime(ms), milliseconds);
async function capture(label) {
  const state = summary(await readState());
  await writeFile(resolve(output, `state-${label}.json`), JSON.stringify(state, null, 2));
  await page.screenshot({ path: resolve(output, `${label}.png`), fullPage: true, timeout: 10000 });
  report.artifacts.push(`${label}.png`, `state-${label}.json`);
  await saveReport();
  return state;
}
async function hold(key, milliseconds) {
  await page.keyboard.down(key);
  try { await advance(milliseconds); } finally { await page.keyboard.up(key); }
  return readState();
}

await saveReport();
try {
  browser = await engines[options.browser].launch({ headless: true, timeout: 20000 });
  report.browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(({ origin, seed, sentinel }) => {
    if (location.origin !== origin) return;
    // Control only the existing practice seed source, never an actor/snapshot/HP value.
    const originalRandom = crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues = array => {
      if (array instanceof Uint32Array && array.length === 1) { array[0] = seed; return array; }
      return originalRandom(array);
    };
    // Session marker prevents a reload from repairing a save that the app accidentally removed.
    if (sessionStorage.getItem('ppi-practice-qa-fixture')) return;
    sessionStorage.setItem('ppi-practice-qa-fixture', 'seeded');
    localStorage.setItem('ppi_idle_save_v1', sentinel);
    localStorage.setItem('ppi_io_save_v1', JSON.stringify({
      gold: 1000, stage: 1, levels: [0, 0, 0, 0, 0, 0, 0], skinId: 'classic',
      lastUnix: Math.floor(Date.now() / 1000), lifetimeGold: 0, runs: 0, portalWins: 0, lastStandWins: 0,
      nick: 'PRACTICE QA', online: { played: 0, wins: 0, kills: 0, recentMatches: [] },
    }));
  }, { origin: target.origin, seed, sentinel });
  // Fail closed if future code starts an online request during this practice-only check.
  await context.route(/https:\/\/challenges\.cloudflare\.com\/|\/api\/(?:join|ws|result)(?:[/?]|$)/, route => {
    report.unexpectedOnlineActivity.push(safeUrl(route.request().url()));
    return route.abort('blockedbyclient');
  });
  page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => { if (collecting) report.pageErrors.push(safeText(error)); });
  page.on('console', message => { if (collecting && message.type() === 'error') report.consoleErrors.push(safeText(message.text())); });
  page.on('requestfailed', request => { if (collecting) report.networkErrors.push({ url: safeUrl(request.url()), error: safeText(request.failure()?.errorText || 'failed') }); });
  page.on('response', response => { if (collecting && response.status() >= 400) report.httpErrors.push({ url: safeUrl(response.url()), status: response.status() }); });
  page.on('websocket', socket => { if (collecting) report.webSockets.push(safeUrl(socket.url())); });
  const response = await page.goto(target.href, { waitUntil: 'networkidle', timeout: 45000 });
  assert.equal(response?.status(), 200, 'deployed page loads');
  await page.waitForFunction(() => typeof window.render_game_to_text === 'function' && typeof window.advanceTime === 'function');
  assert.equal(await page.locator('#offline-popup').isVisible(), false);
  assert.equal((await readState()).connected, false);
  await capture('menu');

  await page.locator('#training-toggle').click();
  for (const upgrade of ['0', '6', '6']) await page.locator(`[data-upgrade="${upgrade}"]`).click();
  const purchased = await readSave();
  assert.deepEqual(purchased.levels, [1, 0, 0, 0, 0, 0, 2]); assert.equal(purchased.gold, 655);
  report.checks.training = { gold: purchased.gold, levels: purchased.levels };
  await capture('training'); await page.locator('#lab-close').click();

  await page.locator('#start-btn').click();
  let current = await readState();
  assert.equal(current.mode, 'practice'); assert.equal(current.humans, 1); assert.equal(current.bots, 9);
  assert.equal(current.player.maxHp, 425); assert.equal(current.player.weapon, 'GUN');
  const movements = [];
  const horizontal = current.player.x > 1500 ? ['a', 'd'] : ['d', 'a'];
  const vertical = current.player.y > 1500 ? ['w', 's'] : ['s', 'w'];
  for (const key of [...horizontal, ...vertical]) {
    const before = await readState(); const after = await hold(key, 150);
    const axis = ['a', 'd'].includes(key) ? 'x' : 'y'; const delta = after.player[axis] - before.player[axis];
    assert.ok(Math.abs(delta) > 25, `${key.toUpperCase()} moves the player`);
    assert.ok(['a', 'w'].includes(key) ? delta < 0 : delta > 0, 'movement direction matches input');
    movements.push({ key, axis, delta });
  }
  report.checks.wasd = movements;
  const normalBefore = await readState(); await advance(200); const normalAfter = await readState();
  const fastBefore = await readState(); const fastAfter = await hold('Shift', 200);
  const normalDrop = normalBefore.player.z - normalAfter.player.z, fastDrop = fastBefore.player.z - fastAfter.player.z;
  assert.ok(normalDrop > 10); assert.ok(fastDrop > normalDrop * 1.5, 'Shift accelerates descent');
  report.checks.shift = { normalDrop, fastDrop }; await capture('dropping');

  current = await readState();
  for (let second = 0; second < 12 && current.mode === 'practice' && current.phase === 'DROPPING'; second++) { await advance(1000); current = await readState(); }
  assert.equal(current.mode, 'practice', 'seeded practice survives into ground combat');
  assert.equal(current.phase, 'GROUND'); assert.equal(current.player.alive, true); assert.equal(current.player.z, 0);
  report.checks.ground = { tick: current.tick, time: current.time, alive: current.player.alive }; await capture('ground');
  const ammoBefore = current.player.ammo;
  await page.mouse.move(900, 360); await page.mouse.down();
  try { await advance(300); } finally { await page.mouse.up(); }
  const fired = await readState();
  assert.ok(fired.player.ammo < ammoBefore, 'actual mouse input fires the equipped gun');
  report.checks.firing = { ammoBefore, ammoAfter: fired.player.ammo }; await capture('firing');

  const goldBefore = fired.practice.gold; await advance(120000);
  const result = await readState(), savedResult = await readSave();
  assert.equal(result.mode, 'result'); assert.equal(result.ended, true); assert.equal(savedResult.runs, 1);
  assert.ok(result.practice.gold > goldBefore, 'natural match result grants a practice reward');
  assert.ok(['win', 'survived', 'death', 'defeated'].includes(result.result?.outcomes?.[String(result.myId)]));
  assert.equal(savedResult.online.played, 0, 'practice does not change online records');
  report.checks.result = { reason: result.result.reason, outcome: result.result.outcomes[String(result.myId)], goldBefore, goldAfter: result.practice.gold, title: await page.locator('#result-title').innerText() };
  await capture('result');

  await page.locator('#again-btn').click(); const restarted = await readState();
  assert.equal(restarted.mode, 'practice'); assert.equal(restarted.player.alive, true); assert.equal(restarted.entities.length, 10);
  assert.notEqual(restarted.matchId, result.matchId);
  report.checks.restart = { matchId: restarted.matchId, entities: restarted.entities.length, alive: restarted.player.alive }; await capture('restart');
  await page.locator('#leave-btn').click();
  assert.equal(await page.evaluate(() => localStorage.getItem('ppi_idle_save_v1')), sentinel, 'original game save remains unchanged before reload');
  const beforeReload = await readSave(); await page.reload({ waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForFunction(() => typeof window.render_game_to_text === 'function');
  const afterReload = await readSave();
  assert.deepEqual(afterReload.levels, purchased.levels); assert.equal(afterReload.gold, beforeReload.gold);
  assert.equal(afterReload.runs, 1); assert.equal(afterReload.stage, beforeReload.stage); assert.equal(afterReload.online.played, 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('ppi_idle_save_v1')), sentinel, 'original save sentinel survives reload');
  assert.equal(await page.locator('#offline-popup').isVisible(), false, 'reload does not repeat offline rewards');
  report.checks.persistence = { gold: afterReload.gold, stage: afterReload.stage, runs: afterReload.runs, levels: afterReload.levels, originalKeyUnchanged: true };
  await capture('reloaded');
  for (const key of ['pageErrors', 'consoleErrors', 'networkErrors', 'httpErrors', 'unexpectedOnlineActivity', 'webSockets']) assert.deepEqual(report[key], [], key);
  report.passed = true;
} catch (error) {
  report.failure = safeText(error.stack || error);
  if (page) { try { await capture('failure'); } catch {} }
  process.exitCode = 1;
} finally {
  collecting = false; report.finishedAt = new Date().toISOString(); await saveReport();
  if (browser) await browser.close();
  console.log(JSON.stringify({ browser: options.browser, passed: report.passed, checks: Object.keys(report.checks), errors: ['pageErrors', 'consoleErrors', 'networkErrors', 'httpErrors'].reduce((total, key) => total + report[key].length, 0), results: resolve(output, 'results.json') }));
}
