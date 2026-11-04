# PoC 기능 보강 API 0.8.0 — 2026-11-01

`master`에 PoC 계약 차이와 서버 예약·뉴스·시세·Web Push 경로를 추가했다. 기존 계정·기록은 `0008_poc_completion` 마이그레이션으로 유지한다. PoC 프론트의 localStorage/IndexedDB 및 BFF는 별도로 연결해야 한다.

## UI와 API 계약

| 화면 동작 | API 계약 |
| --- | --- |
| 내 기능 아이콘 | note/file/book/news/chart/chat/calendar/clock/bell/sun/moon/spark/home/leaf/heart/car/pin/compass 전체 지원 |
| 참고 자료 | 기존 reference와 입력 별칭 content 지원. 둘 다 보내면 정규화한 문자열이 같아야 함. 응답은 reference |
| 한 번 실행 | repeat=once, date 생략 시 지정 timezone의 다음 발생 날짜를 정해 응답에 보관. timezone 생략 시 사용자 비서 문맥(기본 Asia/Seoul). 같은 once 편집에서 date 생략 시 기존 날짜 유지. 재예약은 명시적 새 date 전송 |
| 결과 체크 | items=[{id,text,done}]. PATCH /v1/feature-results/{result_id}/items/{item_id}에 {revision,done} 전송. 전체 결과 반환, 충돌은 409 |
| 결과 항목 생성 | 실제 성공 결과의 Markdown 목록/체크리스트 파싱. 코드 블록·일반 문장 제외. text 원문 보존. 기존 텍스트 결과는 items=[] |
| 취소 알림 재시작 | POST /v1/reminders/{id}/resume {revision,target_at}. 미래 시각 필수, 같은 ID 사용 |
| 알림 +5분 | POST /v1/reminders/{id}/extend {revision,minutes:5}. max(서버 현재,기존 목표)+minutes, 취소 해제. minutes 기본 5, 범위 1~1440 |
| 전달 준비 상태 | HTTP delivery_status는 not_configured/no_subscription/ready. ready는 채널 준비이며 전송 성공이 아님. 채팅 스냅샷은 unknown. deliveries_url에서 기기별 처리 상태 조회 |
| 시간 미지정 주차 | display_mode=manual. PoC 일반 폼의 ‘시간 지정 안 함’을 이 값으로 변환. 기존 always는 항상 표시 의미 유지 |
| 진행 중 일정 | current는 대시보드 표시 구간, ongoing은 실제 starts_at <= 조회 시각 < ends_at. 시작 30분 후 숨기는 PoC ‘지금’ 모델은 프론트 연결 시 수정 필요 |
| 보관함 검색 | GET /v1/library?q=검색어&kind=note&limit=50&offset=0. 전체 제목/메모 본문/문서 본문·파일명/기능 결과의 리터럴 검색, total/has_more/next_offset 반환 |

PUT 전체 교체, 생성 UUID 멱등 키, revision·소유권 검사 계약은 유지한다. 일정 날짜/시간/기간 → starts_at/ends_at, 한국어 반복 → once/daily/weekdays, 로컬 ID → 서버 UUID 등의 프론트 어댑터가 필요하다.

## 서버 예약 실행

API와 별도로 worker를 실행한다. 기본은 비활성이다.

```sh
cd backend
uv sync --frozen
uv run alembic upgrade head
# 서버 환경에 MORI_AUTOMATION_ENABLED=true 및 제공자/runtime 설정
uv run mori worker
# 점검용 한 처리 주기
uv run mori worker --once
```

Compose의 worker는 `automation` profile로 제공한다. 저장소 루트의 `infra/.env`에 설정을 넣고 `docker compose -f infra/compose.yaml --profile automation up -d --build`로 실행한다. API readiness는 DB 스키마 검사이며 worker 생존을 보장하지 않는다. 운영 배포는 이번에 수행하지 않았다.

- 기본 poll 15초, lease 900초, 최대 시도 3회. AI 실행 lease는 Hermes timeout+60초 이상이다.
- timezone의 once/daily/weekdays를 계산한다. DST에 없는 시각은 건너뛰고 중복 시각은 첫 번째를 선택한다.
- DB 커서로 중단 기간의 미실행 시각을 순회한다. 회당 최대 100개를 넣고 `(feature_id,scheduled_at)`는 유일하다.
- SKIP LOCKED로 경쟁 worker를 분리하고 lease token으로 오래된 worker의 완료 저장을 차단한다. 실패는 제한된 지수 backoff로 재시도한다. 마지막 시도 중 중단돼도 lease 회수 시 failed로 마감한다.
- 실행 전후 활성/삭제/revision을 검사한다. 중지·변경 중의 이전 결과를 저장하지 않는다. 결과·대화 실행 이력·job 완료를 같은 트랜잭션으로 보관한다.
- 사용자 기능은 기존 Hermes와 runtime 배정/Pro 검사를 사용한다. 읽기/텍스트 결과 작성만 허용하며 임의 도메인 쓰기 권한을 추가하지 않는다.
- 뉴스는 SearXNG 수집, 주가는 설정된 gateway의 quote 수집이다. 이 둘은 채팅 runtime을 요구하지 않는다.
- GET /v1/automation/jobs?feature_id=UUID&limit=50&offset=0은 본인 실행 이력을 반환한다.
- 중단 후 외부 읽기 요청이 반복될 수 있다. 결과 공개는 lease/고유 키로 보호하며 외부 부작용까지 exactly-once를 보장하지 않는다.

automation_status는 not_requested/not_configured/configured다. configured는 worker와 제공자 설정을 갖춘 상태이며 완료가 아니다. 실행 상태는 jobs로 확인한다. execution_available는 기존 **채팅 진입점** 기준이므로 전용 뉴스/시세 API와 구분한다. 버전 조회는 저장 당시 정의 스냅샷이며 현재 가용성은 최신 기능 조회와 feature-catalog를 사용한다.

## 구조화 뉴스

`MORI_SEARXNG_BASE_URL`에 기존 SearXNG origin을 지정한다(`/search` 제외). JSON 및 news 카테고리가 필요하다. [SearXNG 검색 API](https://docs.searxng.org/dev/search_api)를 사용한다.

- GET /v1/news: 설정 및 마지막 결과. 계정의 builtin_key=news 기능을 재사용한다.
- PUT /v1/news/settings: 최초 {revision:0,topic:"과학",time:"09:00"}. 이후 조회한 revision 사용. time은 매일 시각이며 대신 schedule 객체를 보낼 수 있다. 둘을 함께 보내면 422다.
- POST /v1/news/refresh {revision:1}: 실제 검색 후 보관. 중지 상태는 409다.
- 기사 id/title/summary/summary_type/url/source/published_at와 collected_at을 반환한다. URL 중복을 제거하고 최대 20개를 보관한다.
- summary_type=search_excerpt는 검색 결과 발췌문이며 기사 전문 AI 요약으로 표시하면 안 된다. 별도 Hermes 기능 수동 실행은 기존 텍스트 결과 방식으로 유지한다.
- 수동/자동 수집이 generation을 공유한다. 설정 변경이나 새 수집 후 도착한 이전 응답은 공개하지 않는다. 실패는 failed/error_code로 남긴다.
- 미설정은 503 NEWS_NOT_CONFIGURED, 요청 한도는 503, 비정상 응답/검색 실패는 502다. 제공자의 오류 원문·자격 증명을 노출하지 않는다.

## 관심 종목·시세·캔들

시세 업체는 확정되지 않아 운영자가 지정하는 **quote/candles JSON gateway 어댑터**를 구현했다. 아래 계약을 제공하는 실제 서비스 또는 업체별 gateway가 필요하며, 특정 유료 업체 가입이나 거래소 연결이 포함된 것은 아니다.

서버 설정: MORI_MARKET_DATA_BASE_URL(origin), MORI_MARKET_DATA_API_KEY(선택, Bearer 헤더), MORI_MARKET_DATA_PROVIDER(출처 표시명). 미설정은 503 MARKET_DATA_NOT_CONFIGURED다.

- GET/PUT /v1/market/settings: {revision:0,symbol:"005930.KS"}. 제공자의 종목 키를 사용하며 대문자로 정규화한다. PoC 표시 이름은 프론트에서 매핑한다.
- GET /v1/market/quote?symbol=AAPL. symbol 생략 시 저장한 관심 종목 사용.
- GET /v1/market/candles?symbol=AAPL&range=day|week|month: 1일/1주/1달 차트용.
- GET /v1/market/snapshot: 예약 stock 기능이 보관한 마지막 quote, 미수집은 null.
- builtin_key=stock 기능에 schedule을 지정하면 worker가 관심 종목 quote를 보관한다. 수집 중 종목/revision 변경 시 이전 응답을 취소한다. 채팅 stock 실행의 기존 제한은 유지되며 전용 API를 사용한다.

gateway의 GET /quote?symbol=AAPL 응답:

```json
{"symbol":"AAPL","currency":"USD","price":210,"previous_close":200,"as_of":"2026-11-01T00:00:00Z"}
```

GET /candles?symbol=AAPL&range=day 응답:

```json
{"symbol":"AAPL","range":"day","currency":"USD","as_of":"2026-11-01T00:00:00Z","candles":[{"at":"2026-10-31T00:00:00Z","open":199,"high":215,"low":198,"close":210,"volume":1000}]}
```

숫자·OHLC·시각 오프셋·종목/기간 일치·캔들 오름차순/중복을 검사한다(최대 500개). provider 및 quote의 change/change_percent를 추가한다. 제공자의 as_of를 유지하며 휴장/지연 시세를 현재 값으로 꾸미지 않는다. 호출은 전체 15초/본문 2MB로 제한하고 redirect를 따르지 않는다. 관심 종목 변경 시 snapshot을 제거한다.

## Web Push

[pywebpush](https://github.com/web-push-libs/pywebpush)의 암호화/VAPID 구현을 사용한다. MORI_PUSH_ENABLED=true, 서버 전용 VAPID private key, 대응 public key와 mailto:/HTTPS subject가 필요하다. private는 base64url RAW32 또는 DER P-256, public은 base64url 비압축 P-256 65바이트다. 키 쌍·연락처·허용 호스트를 시작 시 검증한다.

1. GET /v1/notifications/push-config로 enabled/public_key 조회.
2. 프론트에서 권한/service worker를 등록하고 PushSubscription.toJSON()의 endpoint/keys와 device_name으로 POST /v1/notifications/subscriptions.
3. GET /v1/notifications/subscriptions로 본인 id/이름/상태 조회, DELETE /{id}로 해제. endpoint·암호화 키는 응답에 노출하지 않는다.
4. GET /v1/reminders/{id}/deliveries로 queued/processing/retry/sent/failed/skipped 확인.

기본 허용 호스트는 fcm.googleapis.com/updates.push.services.mozilla.com/web.push.apple.com이다. HTTPS 443과 정확한 호스트만 허용하며 설정으로 확장할 수 있다. redirect/환경 proxy는 사용하지 않고 활성 구독은 계정당 최대 20개다.

worker는 목표 시각/기기별 유일한 outbox와 lease/재시도를 사용한다. 취소·삭제·목표 변경·구독 해제/재활성·소유권을 전송 전에 재검사한다. 404/410은 구독을 비활성화한다. 신규·재활성 구독에 그 이전 목표의 옛 알림을 보내지 않는다. 긴 AI 작업이 푸시를 막지 않도록 루프를 분리한다.

sent는 공급자 수락이며 OS 표시 확인이 아니다. 수락 직후 프로세스가 종료되면 재전송될 수 있으므로 service worker는 payload.tag를 showNotification의 tag로 사용해야 한다. 앱 종료 후 알림도 실제 권한/구독/service worker와 운영 worker 연결이 필요하다.

## 적용 및 검증

`uv sync --frozen` → `alembic upgrade head` → API/worker 순서로 적용한다. 0008→0007은 신규 큐/기사/시세/기기/전달 데이터와 체크 상태를 제거하며 manual 주차를 always로 바꾼다. 기존 계정·위치·메모·문서·일정·텍스트 결과는 유지한다.

별도 PostgreSQL 전체 pytest, upgrade/check/0007 downgrade/re-upgrade, server default 포함 모델 비교, Ruff/포맷/OpenAPI/고정 의존성을 검증한다. 공급자/Hermes HTTP 및 푸시는 테스트 transport로 대체하며 실제 계정·시세 업체·검색·OS 표시의 운영 E2E는 별도다. 실제 결제, Office/PDF 변환, 서버 STT, PoC BFF 연결은 이번 변경에 포함하지 않는다.

2026-11-01 결과: **323 passed, 0 failed**. Ruff/포맷(109개 파일)/OpenAPI/고정 의존성/마이그레이션 왕복/서버 기본값 포함 모델 비교를 통과했다. Compose 설정 검증도 통과했다. Docker 엔진이 실행되지 않아 이미지 빌드는 검증하지 않았다. 격리 PostgreSQL은 종료했고 임시 테스트 DB는 모두 제거했다. 상세 로그와 요약은 `backend/output/poc-backend-20261101/validation-final.json`에 있다.
