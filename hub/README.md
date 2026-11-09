# 맹그라미 업무 허브 — hub.mgrm.kr (NAS 저장판)

구글 시트·앱스스크립트 대신 **QNAP NAS** 에 저장하고, **QNAP 계정**으로 로그인하는 업무 허브입니다.
컬러 다이어리(diary.mgrm.kr)와 같은 로그인 쿠키를 써서 한 번 로그인하면 둘 다 열립니다.

```
브라우저 ── hub.mgrm.kr (Cloudflare Worker, 이 폴더) ── Cloudflare 터널 ── NAS 저장 서버 (nas/server.js)
                                                                         ├─ QNAP 계정 확인 (authLogin.cgi)
                                                                         ├─ hub.db (SQLite, 시트 17개 탭 그대로)
                                                                         └─ files/ (잠긴 봉투 JSON)
```

| 폴더 | 내용 | 어디에 |
|---|---|---|
| `nas/` | NAS 저장 서버 + 컨테이너 설정 | QNAP Container Station |
| `src/`, `public/`, `wrangler.toml`, `schema.sql` | hub.mgrm.kr Worker 와 화면 | Cloudflare (이 저장소의 `hub` 폴더를 루트로) |

---

## 0부. 준비 — 무작위 문자열 2개

맥 터미널에서 `openssl rand -hex 32` 를 **두 번** 실행해 메모장에 적어 두세요.
- 첫 번째 → **허브 저장 열쇠** (STORE_TOKEN) — 컬러 다이어리 것과 **다른 값**
- 두 번째 → **데이터 열쇠** (DATA_KEY) — 개인키를 잠그는 열쇠. **한 번 정하면 절대 바꾸지 말 것** (바꾸면 주민번호·계좌를 못 엽니다)

컬러 다이어리 Worker 에 이미 넣어 둔 **SESSION_SECRET** 값도 찾아 두세요 (허브에 같은 값을 넣어야 로그인이 공유됩니다). 모르면 새로 하나 만들어 **둘 다** 바꾸면 됩니다.

## 1부. QNAP

1. **그룹 만들기** — 제어판 → 권한 → 사용자 그룹 → 만들기: `hub-admin`, `hub-staff`
   - 공유 폴더 권한은 **아무것도 주지 않아도** 됩니다 (허브 로그인 판별용)
2. **계정** — 제어판 → 사용자
   - 본인·공동대표 계정 → `hub-admin` 그룹에 체크
   - 조연출·PD 계정 → `hub-staff` 그룹에 체크 (새로 만들 때 공유 폴더 권한은 "접근 거부"로)
   - QNAP 기본 `admin` 계정은 허브 로그인이 **막혀 있습니다**. 꼭 개인 계정을 쓰세요
   - 2단계 인증이 켜진 계정은 허브 로그인이 안 됩니다 (허브용 계정은 끄거나 별도 계정)
3. **데이터 폴더** — 제어판 → 공유 폴더 → 만들기: 이름 `HubData`
   - 권한: **admin 만 읽기/쓰기**, 나머지 전부 접근 거부. 휴지통·스냅샷 켜기 권장
4. **서버 파일** — File Station → `Container` 공유 폴더 → `mgrm-hub` 폴더 만들기 → `nas/server.js` 올리기
   → 경로가 `/share/Container/mgrm-hub/server.js`
5. **NAS 내부 주소 확인** — 제어판 → 시스템 → 일반 설정에서 관리 포트(보통 8080) 확인,
   네트워크에서 내부 IP(예 192.168.0.10) 확인 → `http://192.168.0.10:8080` 형태로 메모

## 2부. Cloudflare 터널 — 주소 하나 추가

Zero Trust → Networks → Tunnels → 기존 `color-diary-nas` → Public Hostname → **Add**
- Subdomain `hub-store` / Domain `mgrm.kr` / Type `HTTP` / URL `hub-store:8080` → Save

(컨테이너 이름이 `hub-store` 라서 같은 앱 안에서는 이 이름으로 찾아갑니다)

## 3부. Container Station

1. 애플리케이션 → 기존 **color-diary** 앱 → 편집(YAML)
2. `nas/docker-compose.yml` 의 `hub-store:` 블록을 `services:` 아래, `tunnel:` 위에 붙여넣기
3. 바꿀 값 4개
   - `STORE_TOKEN=` 허브 저장 열쇠
   - `DATA_KEY=` 데이터 열쇠
   - `QNAP_URL=` 1부 5번 주소
   - (선택) `GAS_URL=` 그대로 두면 구글 캘린더 연동이 예전 앱스스크립트를 통해 계속 동작
4. 적용 → `mgrm-hub-store` 컨테이너가 "실행 중"이면 성공
5. 확인: 브라우저에서 `https://hub-store.mgrm.kr/health` → `{"ok":true,"v":"hub-store 1.0.0"}`

> 별도 앱으로 띄우고 싶으면 새 앱 `mgrm-hub` 로 만들어도 됩니다. 그때는 터널 URL 을 `mgrm-hub-store:8080` 대신 NAS 내부 IP `http://192.168.x.x:8081` 로 잡고 `ports: ["8081:8080"]` 을 추가하세요.

## 4부. Cloudflare Worker (hub.mgrm.kr)

1. **D1** — Storage & Databases → D1 → Create → 이름 `mgrm-hub` → Database ID 복사
   → `wrangler.toml` 의 `여기에_D1_데이터베이스_ID_붙여넣기` 에 넣고 저장 (GitHub 에 올리기)
   → D1 → `mgrm-hub` → Console → `schema.sql` 내용 붙여넣고 실행
2. **Worker 만들기** — Workers & Pages → Create → Import a repository → `mgrmali/mgrm-site`
   - 프로젝트 이름 `mgrm-hub`
   - **Root directory: `hub`** ← 중요 (회사 홈페이지와 같은 저장소라서)
   - Deploy
3. **비밀 값 3개** — Settings → Variables and Secrets → 종류 **Secret**

   | 이름 | 값 |
   |---|---|
   | `STORE_URL` | `https://hub-store.mgrm.kr` |
   | `STORE_TOKEN` | 허브 저장 열쇠 (NAS 와 똑같이) |
   | `SESSION_SECRET` | 컬러 다이어리와 **같은 값** |

4. Settings → Domains & Routes 에 `hub.mgrm.kr` 이 있는지 확인 → 다시 배포
5. `https://hub.mgrm.kr/login` → QNAP 계정으로 로그인 → 첫 화면이 뜨면 성공 (아직 자료는 비어 있음)

## 5부. 자료 이사 (한 번)

1. 관리자로 로그인한 상태에서 `https://hub.mgrm.kr/migrate.html`
2. **예전 관리자 비밀번호** 입력 → "열쇠 꺼내기" (주민번호·계좌 여는 개인키를 NAS 로 옮김)
3. `hub-import.json` 선택 (구글 시트·봉투를 모아 둔 파일 — Claude 가 만들어 드립니다)
4. "NAS 로 보내기" → 결과에 탭별 행 수가 나오면 끝
5. 로그아웃했다가 다시 로그인 → 원천징수 화면에서 인력 정보가 열리는지 확인

## 6부. 컬러 다이어리도 같은 로그인으로

`color-diary` 저장소의 새 버전을 배포하고, Worker 비밀 값에 추가:

| 이름 | 값 |
|---|---|
| `HUB_STORE_URL` | `https://hub-store.mgrm.kr` |
| `HUB_STORE_TOKEN` | 허브 저장 열쇠 |
| `SESSION_SECRET` | 허브와 같은 값 (이미 같으면 그대로) |

`APP_PASSWORD` 는 이제 쓰지 않습니다 (지워도 됨).

## 7부. 회사 홈페이지(mgrm.kr) 정리

허브가 잘 돌면 `mgrm.kr` 루트에 있던 `admin/board/projects/withholding/invoices/vault/submit.html` 을 지우고,
예전 주소로 들어오면 `hub.mgrm.kr` 로 넘기는 설정을 넣습니다. (별도 커밋으로 준비해 드립니다 — 이미 보낸 정산 제출 링크가 깨지지 않게)

---

## 운영 메모

- **NAS 가 꺼져 있으면**: 허브 로그인·화면은 "NAS에 연결할 수 없어요". 외부 **정산 정보 제출 폼은 계속 받아서** Cloudflare D1 에 잠근 채로 보관 → NAS 가 켜지면 10분 안에 자동으로 넘어갑니다. (제출 링크 확인은 전에 한 번이라도 열렸던 링크만 가능)
- **백업**: NAS 서버가 매일 `HubData/백업/hub-날짜.db` 를 만들고 30일 보관. HBS 로 외부 백업을 걸어 두세요. `HubData` 폴더 전체(= hub.db + files/)가 백업 대상입니다.
- **계정 관리**: QNAP 제어판 → 사용자. 그룹에서 빼면 **다음 요청부터 바로** 막힙니다.
- **엑셀로 보기**: 관리자 로그인 후 `https://hub.mgrm.kr/api/export?sheet=지급` 처럼 탭 이름을 넣으면 CSV 가 내려옵니다 (탭 이름: 인력·거래처·프로젝트·작업·지급·게시판·금고·매출·매입·급여자·급여·원천세·초대·제출함·설정).
- **5번 틀리면 15분 잠금** (아이디·IP 각각). `admin` 계정과 2단계 인증 계정은 로그인 불가.
- **열쇠**: 주민번호·계좌 개인키는 `DATA_KEY` 로 잠겨 hub.db 안에 있습니다. `DATA_KEY` 를 잃으면 못 엽니다 — 메모장과 함께 금고에 적어 두세요.
- 구글 캘린더 "보내기"는 당분간 예전 앱스스크립트를 거칩니다 (NAS 가 대신 요청). 앱스스크립트 배포를 지우면 캘린더 연동만 멈춥니다.

<!-- build 2026-11-09 -->
