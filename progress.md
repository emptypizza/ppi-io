Original prompt: Implement PPI.io as a separate public repository from ppi at 7b6e1a3, using Canvas2D, Cloudflare Workers Free + SQLite Durable Objects, two ten-slot rooms, equal PvP stats, free quota admission stops, PC browsers, and separate practice progression.

## Work log

- Imported tracked baseline into a new independent repository; original ppi remains unchanged.
- Parallel implementation: pure simulation, Canvas client/practice economy, Worker/DO lifecycle and quota control.
- Root integrates protocol, build tooling, tests, GitHub repository/Pages, deployment guard and verification.
- Created public repository https://github.com/emptypizza/ppi-io with independent baseline commit6208aa8.
- Implemented pure60Hzsimulation, Canvas client, isolated practice economy, server-authoritative rooms, quota reservations, Turnstile/auth and lifecycle handling.
- Unit51 + actual workerd9 passed; production build~65KB before gzip. Dependency audit0 known vulnerabilities.
- Two-browser online smoke passed locally.20protocol-client/2room soak passed71,169ms and2rounds after jitter-tolerant10Hz token-bucket correction.
- Chromium andWebKit UI/practice passed, fullscreens inspected. Firefox failed before page creation; actualSafari/Edge remain unverified.
- Free-only deploy wrapper correctly refuses deployment without Cloudflare login.
- GitHub Pages configured to deploy validated build via Actions; public config has empty API/sitekey until actualFreeaccount setup.
- Feature commit3e35ff6 pushed; Pages run42338758903 passed all60tests and deployed. Public assets exactly match the build.
- Public Chromium/WebKit passed; nativeSafari27.0.1 basic practicegroundrender/timer/reentry observed through nativeUI. Initialblankcapture was transient, rootcauseunconfirmed. Firefox/actualEdge remain unverified.
- User did not approve the firstWranglerdeviceauthorization within5minutes; request expired without authentication. No Cloudflare account or managed deployment was created.

## External prerequisites

- 2026-11-08: User completed Wrangler device authorization. The target account is authenticated and its Workers plans UI explicitly shows Free, $0, Current plan. No paid upgrade or payment method was added.
- Free verification now supports an explicitly supplied, ignored, exact-account dashboard observation valid for15minutes when Billing Read API access is unavailable. It never overrides a successful paid/ambiguous API response.
- Full check now passes57unit+9workerdtests. Fresh public practice65.5second natural run, Chromium/WebKit functional QA, and local20client71second repeat all pass.
- Worker initially deployed closed at https://ppi-io-api.ppi-io.workers.dev; Turnstile Managed widget and three unique production secrets are configured. Initial TLS errors cleared by14:10KST without changing certificate/DNS settings.
- Commit a84c4fd and Pages run42449573580 succeeded; public config contains the production HTTPS API and public Turnstile sitekey. Secrets remain ignored and local/Worker-only.
- Public origin/challenge/ticket/admin rejection and CORS checks pass. Admin pause/unpause and master gate verified; online currently open for final human-browser verification, DEV_BYPASS false.
- Two independent headless contexts each tried normal Quick Match once, but Turnstile displayed Verify you are human. No CAPTCHA interaction/bypass/retry performed, no join requests or WebSockets created. Challenge auxiliary DNS/PAT errors observed, app page exceptions0. Public multiplayer remains unverified; user was asked to check via their own PC browser.
- Actual signed/notarized Microsoft Edge157 headless practice QA passed. It exposed a missing origin-root favicon request; added an explicit relative SVG icon and verified favicon200/console0 in the updated local build. Standard web-game client also passed two rendered movement iterations. Public icon recheck pending deployment.
- Firefox148/Playwright1.59 on macOS27 failed before page creation in both default headless and normal headed modes; exact sandbox/SWGL logs are preserved under /tmp/ppi-io-firefox-20261108. No security overrides used.
- Added a practice-only cross-browser script and a free Ubuntu Firefox workflow that runs only on manual dispatch. The script uses a fixed practice seed, isolated saved-upgrade fixture, real input, screenshots and the existing advanceTime hook; it aborts online requests. Local Chromium execution passes8checks/errors0. Actual Ubuntu workflow execution pending push/deployment.
- Public PvP on two actual devices/networks remains a deployment verification gate.
- Never share provider tokens or private secrets in chat or Git. If actual service validation fails, close admissions before backend changes and recheck the Free plan before redeployment.
