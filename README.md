# PPI.io

Canvas2D 배틀로얄의 관리형 멀티플레이 알파. PC 브라우저에서 WASD/방향키, 마우스 조준·클릭, Shift 강하/달리기, F 전체화면을 사용합니다.

- 새 사이트: https://emptypizza.github.io/ppi-io/
- 원본 게임: https://emptypizza.github.io/ppi/
- 기준 소스: [emptypizza/ppi @ 7b6e1a3](https://github.com/emptypizza/ppi/commit/7b6e1a376e80f1dae1d9221effec026edf69e821)
- 원작: https://gghf.itch.io/ppi

원본의 추적 파일만 별도 Git 이력으로 가져왔습니다. 원본 저장소와 배포는 그대로 유지합니다.

## 플레이

온라인은 Cloudflare Workers **Free**와 SQLite Durable Objects가 판정합니다. 방2개, 방당10슬롯이며 빈자리는 봇으로 채웁니다. 온라인 인간 능력치는 같고 훈련소 강화는 연습에만 적용됩니다. 무료 사용량 소진 시 온라인 입장을 닫고 다음 한국시간 오전9시에 다시 시작합니다.

Cloudflare 연결 전에는 봇 연습과 훈련소를 플레이할 수 있습니다. 온라인을 연습으로 자동 전환하지 않습니다. 저장 키는 `ppi_io_save_v1`이며 원본 `ppi_idle_save_v1`에는 접근하지 않습니다.

## 개발

Node 버전은 `.nvmrc`, 의존성은 `package-lock.json`으로 고정합니다.

```sh
nvm use
npm ci
npm run check
npm run dev
```

관리형 런타임을 로컬에서 확인하려면 두 터미널을 사용합니다. 개발용 우회는 localhost에서만 동작합니다.

```sh
cp .dev.vars.example .dev.vars
npm run dev:worker
```

```sh
PPI_LOCAL_API_URL=http://127.0.0.1:8787 npm run dev
```

환경변수로 서버 주소를 주입하므로 공개 설정을 localhost 주소로 변경할 필요가 없습니다.

## 구조

- `src/shared`: DOM·오디오·저장에 의존하지 않는60Hz 시뮬레이션과 통신 계약.
- `src/client`: Canvas2D·훈련소·오디오·10Hz 입력·이동 예측·100ms 보간.
- `src/worker`: 입장 예약·일일 예산·두 방·WebSocket·재접속·최종 결과.

SQL에는 예약·생명주기·결과만 저장합니다. 매 tick의 SQL 쓰기나 alarm 호출은 사용하지 않습니다. 방은 최초 예약에서90초 이내에 정리합니다.

배포와 무료 계정 확인 절차: [docs/DEPLOY.md](docs/DEPLOY.md).
