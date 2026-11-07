# 무료 관리형 배포

## 안전한 기본값

`public/config.json`의 API 주소와 sitekey는 비어 있고 `wrangler.jsonc`의 `ONLINE_ENABLED`는 `false`입니다. 계정 설정 전에도 정적 게임과 봇 연습은 동작합니다.

## 계정과 인증

1. https://dash.cloudflare.com/sign-up 에서 무료 계정 생성과 이메일 인증을 완료합니다.
2. Workers 플랜이 **Free**인지 확인합니다. 유료 전환과 결제수단 등록을 하지 않습니다.
3. `npx wrangler login`으로 인증합니다. 비밀번호·OAuth 토큰·API 키를 Git이나 채팅에 기록하지 않습니다.
4. `npm run deploy:worker -- --check`를 실행합니다. 구독 API 조회로 무료 상태가 확인되지 않으면 배포가 실패합니다. 조회 권한이 없으면 인증 권한을 확인합니다.

가입·이메일 인증·로그인은 사용자 본인 확인이 필요한 단계입니다. 로컬 테스트는 계정 없이 실행할 수 있습니다.

## Turnstile과 Worker secret

Turnstile Managed 위젯 hostname을 `emptypizza.github.io`로 설정합니다. 클라이언트 action은 `ppi-io-join`입니다. sitekey는 공개 설정에 넣고 secret은 Worker에만 보관합니다.

```sh
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put HMAC_SECRET
npx wrangler secret put ADMIN_SECRET
```

HMAC_SECRET과 ADMIN_SECRET은 서로 다른32자 이상 임의 값이어야 합니다. `.dev.vars`의 테스트 값을 사용하지 않습니다. ADMIN_SECRET은 운영용 로컬 비밀 저장소에 보관합니다.

## 닫힌 상태로 배포

```sh
npm run check
npm run deploy:worker
```

Free 검사 후 기본 `ONLINE_ENABLED:false`로 배포합니다. 생성된 HTTPS Worker 주소와 Turnstile sitekey를 `public/config.json`에 설정합니다. 비밀 키는 이 파일에 넣지 않습니다.

## 검증 후 온라인 개방

```sh
npm run deploy:worker -- --open
```

다시 Free 상태를 검사합니다. 새 Pages 배포, 두 브라우저 접속, 두 실제 기기·서로 다른 회선의 PvP, 두 방 부하와 한도 차단을 확인합니다. 확인하지 못한 항목은 완료로 기록하지 않습니다.

일일 자체 예산은 참가 예약60,000단위(1회60), 제어10,000단위, 방 실행9,000GB-s(방당12)입니다. 공급자 무료 한도는 계정 전체에서 공유합니다. 알림을 설정한 Paid 플랜은 0원 조건을 충족하지 않습니다.

## 배포와 중단

운영용 `/api/admin`은 ADMIN_SECRET Bearer 인증을 요구합니다. POST `{ "online": false }`로 입장을 닫고 GET으로 방과 deadline을 확인합니다. 방 정리 후 코드를 배포하고 검증 후 POST `{ "online": true }`로 엽니다. ONLINE_ENABLED master gate가 false이면 admin으로도 열리지 않습니다.

비밀 값은 명령행 인자·URL·스크린샷·로그에 남기지 않습니다. 한도 소진·장애·중단 화면은 봇 연습을 명시적으로 제공합니다.

## GitHub Pages

Pages build type을 GitHub Actions로 설정합니다. main push 시 타입 검사·시뮬레이션/예산 테스트·Workers 런타임 테스트·Vite build가 통과한 산출물을 배포합니다. 원본 `/ppi/` 설정은 변경하지 않습니다.
