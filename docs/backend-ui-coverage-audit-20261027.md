# PoC UI와 백엔드 기능 대조 — 2026-10-27

**판정: 기본 데이터 API는 상당 부분 구현되어 있지만, 현재 PoC 화면을 실제 서비스로 사용하기에는 연결 작업과 일부 백엔드 기능 개발이 남아 있다.**

백엔드가 없는 것과 UI가 백엔드를 사용하지 않는 것은 구분해야 한다. 메모·일정·문서·알림 목표·기능 정의·대화 이력·대시보드는 서버 구현이 있다. 그러나 화면의 주요 동작은 localStorage/IndexedDB 기반 체험이다. 뉴스 수집·실시간 시세·서버 예약 실행·OS 푸시·실제 결제는 서버에서도 완성되지 않았다.

## 검토 대상과 방법

- UI: `C:/Users/111/Desktop/Github/mori`, `poc`, HEAD `0d9874a` 및 현재 미커밋 변경. 실제 진입점은 `index.html` → `src/app-experience.js`다. 이전 `src/app.js`의 API 호출을 현재 화면 연결로 계산하지 않았다.
- 백엔드: `C:/Users/111/Desktop/Github/mori-master`, `master`, HEAD `53b0fa6`, API 0.7.0. 해당 작업 폴더는 검토 시 clean이었다.
- 사용자 지정 ego-browser로 실제 화면을 열고, UI 조작 후 DOM·표시 문구·저장 데이터·Resource Timing의 `/api/` 요청을 확인했다.
- UI에서 주차 저장, 메모 생성/삭제, 문서 업로드/다운로드/삭제, 일정 생성/수정/삭제, 알림 생성/연장/취소/재시작, 기능 실행/체크/중지, 채팅 메모 저장, 음성 입력 화면, 로그인 선택, 요금제, 테마 옵션, 주가 기간, 뉴스 재수집, 대시보드 시간 범위를 확인했다.
- PostgreSQL 18의 별도 임시 클러스터(127.0.0.1:55434)를 만들어 기존 DB와 분리했다. 전체 백엔드 테스트 및 마이그레이션을 실행하고, 별도 검증용 API의 public/unauthenticated 요청도 확인했다.
- 애플리케이션 소스는 수정하지 않았다. 이 보고서와 `output/backend-ui-audit-20261027/`의 검증 자료만 추가했다.

## 기능별 상태

| UI 기능 | master 백엔드 구현 | 현재 PoC UI 연결/관찰 | 판정 |
| --- | --- | --- | --- |
| 오늘 / 지금·3시간·5시간·하루 | `GET /v1/dashboard` 구현. 시간 범위, 현재/예정 구분, 최근 기록 제공 | 로컬 계산. 하루 전환 후에도 `/api/dashboard` 요청 없음 | API 연결 필요, 표시 정책 일부 불일치 |
| 기록 보관함 | `GET /v1/library` 구현. 메모·문서·기능 결과 및 페이지 처리 | 로컬 배열 검색·분류·정렬 | API 연결 필요 |
| 주차 위치·용도·요일·표시 기간 | 생성/최신 조회, 멱등성, 표시 설정 구현 | 일반 주차 화면 저장은 로컬. `AUDIT-B27` 저장 시 API 요청 없음 | 서버는 구현, 정상 화면 연결 필요 |
| 메모 작성·조회·수정·삭제·복원 | `/v1/notes` CRUD/restore, 검색·revision·멱등성 구현 | 테스트 메모 생성/삭제가 로컬에서 처리됨 | API 연결 필요 |
| 일정 월·주·일 및 CRUD | `/v1/calendar/events` 기간 조회/CRUD/restore 구현 | 월 화면·작성·수정·삭제 확인. 로컬 데이터 사용. 주·일 모델은 코드/기존 테스트로 확인 | API 연결 및 필드 변환 필요 |
| 채팅·대화 이력·검색·고정·이름 변경·삭제 | conversations API 및 메시지 SSE 구현 | 채팅 메모 저장 후에도 요청은 `/api/session`뿐. 정규식 `applyRequest`로 답변 생성 | 실제 채팅 연결 필요 |
| 음성 입력 | 인식된 텍스트를 기존 채팅으로 보낼 계약 있음. 서버 STT 없음 | 브라우저 SpeechRecognition 기반 입력 화면. 실제 마이크 녹음은 이번에 실행하지 않음 | 브라우저 인식 범위. 전송할 실제 채팅 연결 필요 |
| 알림 생성·남은 시간·+5분·취소 | 목표 시각 CRUD/cancel/restore 구현 | 로컬 카운트다운 및 상태 변경 | API 연결 필요, 재시작 의미 조정 필요 |
| 기기 알림 / 앱 종료 후 알림 | `delivery_status=not_configured`, 푸시 구현 없음 | 화면도 기기 알림 미지원이라고 안내 | 백엔드 추가 개발 필요 |
| 내 기능 작성·편집·버전·중지 | 기능 정의/버전/활성·중지 API 구현 | 로컬 기능 배열 사용. 아이콘·한 번 예약 계약 불일치 | 연결 및 계약 조정 필요 |
| 내 기능 지금 실행 | 기존 채팅의 `feature_id`로 Hermes 실행, 결과/실행 당시 버전 보관 구현 | 로컬 메모 제목을 할 일로 바꿈. Hermes 호출 없음 | 실제 실행 연결 필요 |
| 실행 결과 완료 체크 | 서버 결과는 `text` 중심. 항목별 `done` 저장/수정 API 없음 | 화면의 체크 버튼은 `result.items[].done`을 로컬 저장 | 같은 UI를 유지하려면 서버 기능 추가 필요 |
| 뉴스 브리핑·기사 요약·출처 | 수동 Hermes 기능 실행으로 텍스트 결과를 보관할 수 있음. 기사별 구조화 데이터/정기 수집 서비스 없음 | 기사 3개는 고정 예시. 새로 수집은 약 1.7초 뒤 로컬 상태 변경 | 현재 화면 수준의 뉴스 백엔드 추가 필요 |
| 관심 주가·종목·일/주/월 차트 | 시세 공급자/캔들 조회 API 없음. stock 기능 실행은 `503 MARKET_DATA_NOT_CONFIGURED` | 고정 예시 가격·차트. 1주 전환도 API 요청 없음 | 백엔드 추가 개발 필요 |
| TXT/MD/CSV 원문 보관·다운로드 | 10,000,000 UTF-8 bytes 이내 저장/목록/상세/download/delete/restore 구현 | 메타데이터 localStorage, 원문 IndexedDB. 테스트 파일 다운로드는 업로드 원문과 일치 | 서버는 구현, UI 연결 필요 |
| 문서 AI 요약·Word/Excel/PDF 변환 | 사용자 문서 API에 미구현 | 화면도 Office/PDF 미지원 안내 | 별도 개발 범위 |
| 네이버·카카오 로그인·로그아웃 | OAuth/PKCE/일회용 코드/갱신/세션 폐기 구현 | BFF를 통해 연결된 코드 있음. 검증용 API에 실제 소셜 키를 넣지 않아 로그인 버튼 비활성까지 확인 | 구현/연결 있음, 실제 소셜 계정 E2E 미검증 |
| 사용자 정보·이름·테마 | `/v1/me`, `/v1/me/settings` 및 revision 구현 | 프로필/테마 API 연결 코드 있음. 게스트 테마는 로컬. 화면 옵션 확인 | 연결 있음, 인증 후 브라우저 E2E 미검증 |
| 요금제·결제·구독 해지 | 플랜/이용권 조회 구현. 실제 결제/해지 없음. 관리자 승인 Pro와 유료 구독 구분 | `/api/plans` 실제 호출 및 Free/Pro 안내 확인. 결제/해지는 비활성 | 조회 연결됨, 결제 서비스 추가 필요 |
| 예약 자동 실행 | schedule 저장만 구현. `scheduled_execution=false` | 로컬 `tickScheduled`가 열린 앱에서 실행/당일 보정 | 앱 종료 후 실행을 위한 서버 작업 필요 |

## 우선순위가 높은 확인 사항

### 1. [P1] 실제 UI와 백엔드 사이에 핵심 데이터 경로가 없다

화면은 `src/app-experience.js:35`의 `mori.experience.v6`를 읽고 `:123`의 `save()`로 저장한다. 일반 주차 폼, 메모, 일정, 내 기능 저장도 이 경로다. 채팅 역시 `:933`의 `send()`에서 지연 후 `applyRequest()`를 호출한다.

서버 API가 있어도 현재 BFF(`scripts/server.mjs`)는 인증·계정·요금제·주차 일부만 중계한다. 다른 `/api/*`는 `:171`에서 404다. 실제 실행 결과도 다음과 같다.

| 요청 | 응답 | 의미 |
| --- | --- | --- |
| `GET :8000/health/live`, `/health/ready` | 200 | 별도 테스트 API와 최신 스키마 정상 |
| `GET :8000/v1/notes`, `/v1/dashboard` (무인증) | 401 | 서버 경로는 있으며 인증 필요 |
| `GET :4173/api/notes`, `/api/dashboard`, `/api/conversations` | 404 | UI 서버에 해당 중계 경로 없음 |
| `GET :4173/api/parking/latest` (무인증) | 401 | 주차 중계는 있지만 인증 필요 |
| `GET :4173/api/providers`, `/api/plans` | 200 | 공개 계정/요금제 중계는 실제 동작 |

주차에도 `live-parking` 저장 핸들러는 남아 있지만 일반 주차 UI는 `parking-form`을 사용한다. 현재 진입점에서 `live-parking-form` 버튼을 생성하거나 `/parking/latest`를 호출하는 경로는 찾지 못했다. 이 핸들러만으로 주차 화면이 연결됐다고 볼 수 없다.

완료 조건은 로그인 후 같은 계정의 기록이 새 브라우저/기기에서도 조회되고, 직접 작성과 채팅 작성이 동일한 서버 기록을 사용하며, 실패 시 UI가 저장 성공으로 표시하지 않는 것이다. PoC seed 기록을 실사용자의 서버 데이터로 자동 업로드해서는 안 된다.

근거: `parking-evidence.json`, `note-evidence.json`, `event-evidence.json`, `document-evidence.json`, `chat-evidence.json`, `runtime-probes.json`.

### 2. [P1] 예약·푸시·시세·뉴스 서비스는 API 연결만으로 완성되지 않는다

`backend/src/mori/features/router.py:32`의 capabilities는 예약 실행/푸시/시세/Office 변환을 false로 반환한다. 대시보드도 `automation_not_configured`, `delivery_not_configured`를 제공한다.

- 서버 예약 실행: 지속 실행하는 worker/scheduler, 실행 중복 방지, 실패/재시도/중지 및 실행 이력이 필요하다.
- 알림: 실제 전달 수단과 기기 등록/전달 상태가 필요하다.
- 주가: 종목·가격·기준 시각·캔들 데이터를 공급하는 서버 계약이 필요하다.
- 뉴스: 현재 기사 목록 UI를 유지하려면 제목/요약/원문 URL/출처/수집 시각의 구조화 결과가 필요하다. 일반 텍스트 기능 결과와는 형식이 다르다.

실제 자동화가 준비되기 전에는 capabilities/availability를 사용해 예약 저장과 실제 실행 보장을 구분해야 한다. 하루 화면에서는 현재 '수집 시작', '예약됨', '실행 예약'으로 표시된다.

Hermes 채팅 자체도 기본 비활성이다. 공용 runtime은 지정된 한 사용자로 제한되며, Pro 개인 runtime은 서버에서 미리 배정해야 한다(`backend/src/mori/chat/runtime.py`). 따라서 현재 코드만 배포한다고 모든 소셜 사용자가 AI 채팅을 사용할 수 있는 상태는 아니다.

### 3. [P1] 내 기능의 결과 체크박스를 저장할 서버 계약이 없다

UI는 `src/app-experience.js:862`, `:1318`에서 `result.items[{text,done}]`을 표시하고 수정한다. 실제 UI에서 실행 → 완료 체크 → 중지를 확인했고 `done=true`가 로컬에 저장됐다.

반면 `backend/src/mori/features/schemas.py:51`의 `FeatureResultRead`는 `text`, `run_id`, `feature_version` 등을 제공하며 체크 항목이 없다. 결과 라우터도 읽기 전용이다. 서버 결과를 그대로 연결하면 체크리스트 표시와 완료 상태 동기화를 지원할 수 없다.

현재 UI를 유지하려면 구조화된 결과 항목/안정적인 항목 ID/완료 상태 수정·revision 계약이 필요하다. 텍스트 결과로 UI를 바꾸는 선택도 가능하지만 현재 UI와 다른 동작이 된다.

### 4. [P2] '한 번 실행'에 필요한 날짜 입력이 없다

UI의 `customForm()`과 `normalizeCustomSchedule()`은 시간과 '한 번'만 저장한다. API의 `Schedule.once_date()`는 `repeat=once`일 때 `date`를 필수로 요구한다. 실제 Pydantic 검증에서도 날짜 없는 예약은 거부됐다.

한 번 실행할 날짜를 입력받고 저장/조회에 유지해야 한다. '필요할 때'는 schedule=null, '매일/평일/한 번'은 daily/weekdays/once로 변환하는 어댑터도 필요하다.

### 5. [P2] UI 아이콘 두 개가 서버 허용값에 없다

UI는 '일상'=`leaf`, '여행'=`compass`를 선택할 수 있다. API는 spark/note/news/bell/calendar/chart만 허용한다(`backend/src/mori/features/schemas.py:29`). 두 아이콘 모두 모델 검증에서 거부됐다. 아이콘 계약을 맞추지 않으면 이 선택값으로 기능을 저장할 때 validation 오류가 발생한다.

근거: `contract-validation.json`. 실제 API의 공통 검증 실패 응답은 422다.

### 6. [P2] 알림 재시작과 +5분의 상태 전이가 다르다

UI는 취소된 알림을 같은 ID로 '다시 30분 시작'할 수 있다. +5분도 `cancelled=false`로 바꾼다(`src/app-experience.js:1320`). 실제 브라우저 검증에서도 재시작 전후 ID가 같고 cancelled가 true→false로 바뀌었다.

서버 PUT은 목표 시각/제목을 바꾸지만 cancelled를 해제하지 않는다. `/cancel`은 취소만 지원한다. 현재 계약에 맞추려면 재시작은 새 알림 생성으로 연결하고 새 ID로 상세를 바꾸거나, 서버에 명시적인 재개 계약을 추가해야 한다. 단순 목표 시각 PUT으로 연결하면 화면은 재개됐는데 서버 알림은 계속 취소 상태로 남는다.

근거: `reminder-evidence.json`, `backend/src/mori/organizer/service.py:33`, `backend/src/mori/organizer/reminders.py:85`.

### 7. [P2] 대시보드 표시 정책을 통일해야 한다

- PoC의 '시간 지정 안 함'은 내부적으로 display_mode=always를 저장하면서 대시보드에서 제외한다(`src/experience.mjs:44`). 백엔드 always는 최신 주차를 계속 표시한다(`backend/src/mori/dashboard/service.py:168`). 같은 값의 의미가 다르다. 현재 '시간 미지정' 정책을 유지하려면 숨김/수동 조회 모드를 구분하거나 서버 표시 정책을 조정해야 한다.
- PoC '지금'은 일정 시작 30분 뒤부터 진행 중인 일정도 제외할 수 있다(`src/experience.mjs:33`). 서버는 종료까지 표시하며 3시간 로컬 타임라인도 duration을 반영한다. 10:30~12:30 일정 하나를 둔 11:15 기준으로 재현했을 때 '지금'은 빈 배열, 3시간 보기에는 '지금 표시 중' 일정이 있었다.
- PoC는 기본 seed/가상 시계로 오전 8:40부터 시작한다. 서버는 실제 server_time과 timezone을 사용하므로 실서비스에서는 같은 기준 시각으로 남은 시간과 표시 범위를 계산해야 한다.

근거: `dashboard-contract-probe.json`, `dashboard-evidence.json`.

## 연결 구현에 필요한 공통 처리

1. BFF에 도메인별 허용 경로와 query/body 전달을 추가한다. 채팅에는 JSON 일괄 응답이 아닌 SSE 중계와 클라이언트 스트림 처리가 필요하다. 현재 `src/api.mjs`는 response.json()만 처리한다.
2. 생성에는 안정적인 UUID Idempotency-Key를 사용하고 재시도 시 재사용한다. 수정/삭제/복원에는 조회한 revision을 사용하고 409를 처리한다.
3. UI/API 모델을 변환한다. 일정 date/time/duration/color → starts_at/ends_at/timezone/category, 기능 content → reference, active → status, 한국어 반복값 → 서버 enum 등이 필요하다. seed의 임의 문자열 ID는 서버 UUID로 사용할 수 없다.
4. 실사용 데이터는 계정에 따라 분리한다. 현재 PoC의 단일 localStorage 키/IndexedDB 기록은 실계정 데이터로 취급하면 안 된다. 로그인/로그아웃/계정 변경 시 캐시와 진행 중 요청도 계정에 맞게 관리해야 한다.
5. 문서 중계는 원문 10MB 외 JSON 인코딩·메타데이터 크기도 고려한다. 현재 BFF의 공통 body()는 8,192바이트 제한이므로 그대로 재사용하면 문서 계약을 충족하지 못한다. 목록은 메타데이터, 원문은 상세/download로 분리한다.
6. 서버 capabilities 및 오류를 UI에 반영한다. 미구현 실행을 완료로 표시하거나, 서버 장애 시 로컬 성공으로 대체하지 않는다.

## 검증 결과와 한계

| 검사 | 결과 |
| --- | --- |
| UI `npm run check` | 통과 |
| UI `npm test` | 마지막 재실행에서 **338 passed, 0 failed** |
| backend `pytest -q` | 실제 별도 PostgreSQL에서 **204 passed**. 테스트 도구 deprecation warning 2개 |
| backend Ruff check / format --check | 통과, 85 files formatted |
| OpenAPI export --check | 통과 |
| 빈 검증 DB의 Alembic upgrade head | `0007_parking_display`까지 성공 |
| 검증 API live/ready | 모두 200 |
| TXT 업로드 → 원문 다운로드 | 파일 내용 일치 |
| 기능 아이콘/한 번 예약 계약 재현 | leaf/compass/날짜 없는 once 거부, daily 정상 |
| 실제 소셜 계정 로그인·인증 후 브라우저 CRUD | 이번 검증 범위 밖. 검증용 API에는 실제 소셜 키를 넣지 않았음 |
| 실제 Hermes 모델·검색·GPU 왕복 | 이번 검증 범위 밖. 백엔드 테스트는 Hermes를 mock으로 대체 |
| 실제 마이크 인식·OS 푸시·결제 | 미실행. 브라우저 음성 UI/지원 API 유무만 확인 |
| 운영 배포 상태·실기기 iPhone/iPad | 검증하지 않음 |

테스트 통과는 각 코드의 기존 계약을 검증한 결과다. 위 UI/API 형식 차이와 연결 누락을 해결했다는 뜻은 아니다.

UI 파일은 미커밋 변경을 포함해 검토했고 검토 중에도 수정본이 반영되었다. 최종 테스트 수는 재실행 시점 기준이다. 코드 위치는 후속 편집에 따라 달라질 수 있다.

검증 자료: [`output/backend-ui-audit-20261027/`](../output/backend-ui-audit-20261027/). 특히 `runtime-probes.json`, `contract-validation.json`, 각 기능의 `*-evidence.json`과 `dashboard-contract-probe.json`으로 관찰 결과를 확인할 수 있다.

검증용 API와 PostgreSQL은 종료했다. 테스트 메모·일정·문서는 삭제하고 감사 중 생성한 모바일 미리보기 데이터도 제거했다. 임시 PostgreSQL 폴더 삭제는 자동 승인 검토가 정책상 차단하여 파일만 남겼으며 해당 폴더와 DB 로그는 검증 폴더의 `.gitignore`로 추적에서 제외했다.

추천 순서는 **기본 CRUD/대화/대시보드 API 연결 → 결과·예약·아이콘·알림·표시 정책 정합성 → 서버 예약/푸시/뉴스/시세 → 실제 계정·Hermes E2E 검증**이다. 결제와 Office/PDF 변환은 현재 화면에서도 준비 중/미지원으로 안내하므로 별도 범위로 진행할 수 있다.
