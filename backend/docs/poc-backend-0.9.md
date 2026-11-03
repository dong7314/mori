# Backend 0.9: 화면 기능과 백그라운드 실행

이 버전은 PoC 화면을 연결할 API와 서버 작업을 구현한다. PoC 브랜치의 화면, 로컬 저장 데이터, 접속 주소는 바꾸지 않는다. 코드 검증과 실제 서비스 배포를 구분하며 외부 키 등록, 유료 결제, Kubernetes 리소스 생성은 개발 검증에서 수행하지 않는다.

## 기능별 연결

| 화면/흐름 | API와 처리 주체 | 운영 전 필요한 설정 |
|---|---|---|
| 로그인·프로필·테마 | 기존 `/v1/auth/*`, `/v1/me/*` | 네이버·카카오 앱과 콜백 |
| 대시보드·기록 검색 | `/v1/dashboard`, `/v1/library`에 본인 기록·파일 메타데이터 통합 | PostgreSQL |
| 대화·진행 상태 | 대화 생성 → `/runs` 등록 → `/events` 관찰; worker가 실행 | 채팅 worker, 사용자별 Hermes 연결 |
| 주차·메모·일정·알림 | 기존 CRUD와 서버가 검증하는 채팅 저장 작업 | 알림 전달은 별도 Push 구독 |
| 사용자 기능 | 정의·버전·결과·체크리스트, 명시적인 `allowed_actions` | 예약 worker와 Hermes |
| 예약·콜드 스타트 | Mori DB의 예약 시각 → 사전 기동 → 실행 → 결과·알림 | automation worker, 개인 Knative 또는 공용 gateway |
| 뉴스 | SearXNG 기사 수집 후 선택적으로 AI 요약, 원문 링크 보존 | SearXNG, 요약용 Hermes |
| 관심 종목·캔들 | KIS 국내 주식 당일 1분봉·기타 기간 일봉, 종가 조회·예약 저장 | KIS 앱 키·시크릿, 해외 종목 거래소 매핑 |
| 문서·파일 | 파일 업로드 → document-job → 결과 조회·다운로드 | 문서 worker와 폰트 |
| 마이크 | 음성 업로드 → 텍스트 전사 → 사용자가 채팅 제출 | Whisper 호환 전사 서버 |
| 웹 알림 | 기존 기기 구독 API와 Web Push worker | HTTPS·VAPID·브라우저 알림 허용 |
| 웹 Pro 결제 | Toss 빌링키 발급 → 주문 검증·청구 → 기간 권한 | Toss 키, 서버 가격, 고정 콜백 URL |
| 개인 에이전트 | 유효 Pro 권한 감지 → Secret/PVC/Knative Service | 별도 provisioner와 제한된 Kubernetes RBAC |

Swagger `/docs`, Scalar `/scalar`, [저장된 OpenAPI](openapi.json)는 동일한 API 계약을 사용한다. 인증 우회 토큰은 추가하지 않는다. 사용자 ID는 Mori 인증 결과에서 결정하며 클라이언트나 모델이 다른 사용자를 선택할 수 없다.

메모·기록·대화 목록의 검색어 `q`는 기본 빈 문자열, 최대 200자를 유지하며 NUL 문자는 `422 VALIDATION_ERROR`로 거부한다. 이 제약은 OpenAPI에도 표시한다. 한글·줄바꿈·공백과 `%`, `_`, 역슬래시의 기존 검색 의미 및 사용자별 조회 범위는 유지한다.

일정의 시작·종료와 알림 목표 시각은 UTC로 변환해 저장·재조회할 수 있는 값이어야 한다. UTC 범위를 벗어나면 저장 전에 `422 INVALID_DATETIME`을 반환한다. 종일 일정의 현지 날짜 변환 실패는 입력 검증 오류로, 알림 연장 결과가 범위를 넘는 경우는 `422 INVALID_REMINDER_TARGET`으로 처리한다. 실패한 연장은 현재 목표·취소 상태·revision을 유지한다. 이전 버전에서 잘못 저장한 날짜는 자동 변경하지 않으며, 소유자가 올바른 날짜와 현재 revision으로 PUT하여 복구할 수 있다. 기존 생성 응답의 멱등 재생은 당시 값을 유지한다.

## 채팅: 등록과 관찰 분리

새 클라이언트는 다음 순서를 사용한다. 모든 사용자 API에 Mori Bearer 토큰을 보낸다.

1. `POST /v1/conversations`로 대화를 만들거나 기존 대화를 선택한다.
2. `POST /v1/conversations/{id}/runs`에 UUID `Idempotency-Key`와 `{"message":"..."}`를 보낸다. 응답은 202이며 `run_id`, `status_url`, `events_url`을 제공한다.
3. `events_url`을 인증된 fetch 스트림으로 읽는다. 연결은 기본 25초 동안만 관찰하며 종료되어도 서버 작업은 계속된다.
4. 마지막 SSE ID인 `<run UUID>:<순번>`을 저장한다. 재접속 시 `Last-Event-ID` 헤더 또는 `?after=<순번>`을 보낸다. 연결 종료만으로 성공·실패를 판단하지 않는다.
5. 상태 조회에서 완료를 확인하고 결과 참조로 실제 저장 내용을 연다. 사용자가 취소하면 `POST .../runs/{run_id}/cancel`을 보낸다.

기존 `POST .../messages`도 작업을 등록한 뒤 SSE를 관찰한다. 새 요청에는 새 키, 같은 요청의 재시도에는 같은 키를 사용한다. 동일 대화에서 진행 중인 다른 요청은 충돌로 처리한다. API 프로세스가 종료되어도 DB의 작업이 남으며 worker는 lease 만료 후 제한된 횟수로 복구한다. 모델 호출은 복구 중 다시 일어날 수 있다. Mori 저장 작업은 lease·실행 상태를 다시 확인하고 결과 완료와 함께 커밋한다. 외부 시스템 전체에 대한 exactly-once 실행을 약속하지 않는다.

`runtime.connecting`, `tool.started`, `tool.returned`, `action.started`, `action.completed`, `message.completed`, `run.completed`는 실제 처리 단계다. 숨겨진 추론을 노출하지 않는다. 문서 요청은 `action.queued`와 `document_job` 참조를 반환한다. 채팅 완료는 문서 편집 완료를 뜻하지 않으므로 document-job을 이어서 조회한다.

취소와 권한 회수는 아직 커밋하지 않은 Mori 저장을 막는다. 이미 완료한 저장을 자동으로 되돌리거나 실행 중인 외부 검색을 즉시 취소하지는 않는다. 실행 결과와 원본 리소스를 조회해 최종 상태를 확인한다.

### 명시적인 문서 첨부

`/runs`와 `/messages`의 본문에 `attachments`를 최대 3개 넣는다. `file`은 `/v1/files`에서 업로드한 파일, `document`는 기존 `/v1/documents`에 보관한 텍스트 문서다. 경로나 외부 URL을 보내지 않는다.

```json
{
  "message": "첨부한 회의록을 요약해 줘",
  "attachments": [{"kind": "file", "id": "<본인 파일 UUID>"}]
}
```

첨부 참조도 요청 중복 검사에 포함된다. 같은 키로 다른 문서를 보내면 409다. 접수 시 소유권을 확인하고 worker가 제한된 파서로 문서를 읽은 뒤 모델에 전달한다. `attachment.started`/`attachment.completed`는 문서 읽기 상태다. 최근 파일 목록에 없는 파일도 명시적으로 선택할 수 있다. 첨부별 미리보기는 10,000자로 제한하며 문서 자체 추출 제한과 잘림 여부도 모델에 알린다. 파일의 매크로나 지시문을 실행하지 않는다.

모델 응답을 저장하기 전 소유권과 삭제 상태를 다시 확인한다. 문서 읽기 실패는 `ATTACHMENT_UNREADABLE`로 종료하고 본문을 읽은 것처럼 답하지 않는다. 읽는 중 취소하면 모델 호출·최종 저장을 이어서 수행하지 않는다. 응답을 이미 전송한 외부 모델에서 자료를 회수한다는 의미는 아니다.

## 무료 공용 Hermes와 Pro 개인 환경

무료 계정도 공용 Pod 하나를 사용할 수 있다. 다만 프롬프트에 사용자 ID를 적는 것으로 격리를 대신하지 않는다. Mori가 인증된 ID를 `X-Mori-User-ID`에 넣고 서버 전용 키로 gateway를 호출한다. gateway는 사용자별 자식 프로세스, HOME/HERMES_HOME, 파일 경로와 내부 API 키를 분리한다. 임의 도구, 임의 경로, 사용자 제공 upstream 헤더는 전달하지 않는다.

같은 컨테이너 UID를 사용하는 논리적 프로필 격리이므로 임의 코드를 실행하는 적대적 작업의 보안 경계로 쓰지 않는다. 공용 모드는 제한된 검색 도구만 허용하며 파일 처리는 Mori 문서 worker에 맡긴다. 실행 프로세스 수·프로필 수·디스크 사용량을 제한한다. 개인 Pro 환경은 별도 Knative Service/PVC/키를 갖는다.

- `MORI_SHARED_HERMES_ENABLED=true`, `MORI_SHARED_HERMES_BASE_URL`, `MORI_SHARED_HERMES_API_KEY`로 새 gateway를 명시적으로 활성화한다.
- 기존 `MORI_HERMES_TEST_USER_ID` 경로는 단일 테스트 소유자용 호환 설정이다.
- Pro 자동 배정이 활성화되었는데 개인 환경이 준비되지 않으면 준비 오류를 반환한다. 공용으로 몰래 우회하지 않는다.
- `GET /v1/me/runtime`의 `ready`는 Knative Route 준비 상태다. Pod가 항상 떠 있다는 뜻은 아니다.
- 구독 만료·관리자 권한 회수 시 실행 자격을 DB에서 재검사한다. 개인 환경을 중단해도 PVC는 보관한다. 무료 공용 프로필과 개인 PVC 사이의 자동 메모리 이사는 구현하지 않았다.

상세 배포와 회수 절차는 [개인 런타임 문서](../../infra/k3s/runtime-provisioning.md), 공용 설정은 [gateway 배포 문서](../../infra/k3s/shared-gateway.md)를 참고한다.

## 예약과 사용자 기능 권한

예약 원장은 Mori DB다. Hermes cron에 같은 예약을 중복 등록하지 않는다. 예약 worker가 실행 전 기본 120초 구간에 진입한 사용자의 인증된 toolsets 조회로 환경을 깨운다. 사전 기동이 실패해도 해당 시점의 실행 기록으로 실패·재시도를 관리한다. 준비 완료 시각이나 초 단위 정시 실행을 보장하지 않는다.

일회성 예약의 날짜·시간대는 사용자 기본값이나 기존 예약에서 가져올 값을 모두 적용한 뒤 UTC 변환 가능 여부를 검사한다. 표현 범위를 넘는 조합은 저장 전에 `422 VALIDATION_ERROR`로 거부한다. 이미 저장된 잘못된 예약은 해당 revision만 큐에서 격리하며, 조회·중지·정상 값으로 수정은 유지한다. 수정하면 다음 회차를 다시 계산한다. 임의의 연도 제한을 추가하거나 DST의 건너뛰기·첫 시각 선택 정책을 바꾸지 않는다.

사용자 기능은 `allowed_actions`를 가진다. 기본값은 `["reply"]`이며 메모·일정·알림·주차·문서 처리는 편집 API에서 명시적으로 허용해야 한다. 지원 값은 `reply`, `note_save`, `event_save`, `reminder_save`, `parking_save`, `document_process`다. 모델은 기능을 만들면서 스스로 저장 권한을 얻지 못한다. 실행에 사용한 정의와 권한을 버전에 고정하고, 실행 중 수정·중지·권한 회수가 발생하면 최종 저장 전에 다시 검사한다.

일반 대화는 사용자 요청을 해석해 기존 지원 작업을 수행한다. 서로 다른 저장 작업 2~4개를 묶는 batch를 지원한다. 예를 들어 주차 위치와 알림 목표를 함께 저장한다. 저장 결과를 하나의 트랜잭션으로 처리하므로 일부만 저장된 상태로 성공을 반환하지 않는다.

### 예약 회차 조회와 취소

`GET /v1/automation/jobs/{id}`에서 특정 회차와 `next_attempt_at`, 대화 `run_url`/`events_url`을 확인한다. `POST /v1/automation/jobs/{id}/cancel`은 그 회차만 취소하며 반복 기능 자체의 예약은 유지한다. 같은 취소를 재요청해도 완료 작업을 되돌리지는 않는다. 재시도 중에는 대화 상태를 `running`, 이벤트를 `run.retrying`으로 유지하고 재시도 한도를 소진한 뒤 실패로 종료한다.

늦게 복구한 예약은 실제 복구 시각 대신 원래 `scheduled_at`과 기능의 시간대를 사용한다. 모델 문맥의 `reference_at`/`execution_timezone`, 메모의 `notes_window`가 이를 명시한다. 예를 들어 어제 실행하지 못한 메모 정리를 오늘 재시도해도 어제 날짜의 메모를 읽는다.

## 문서와 음성 계약

문서 작업의 `spec`은 서버가 직렬화한 UTF-8 JSON 기준 200,000바이트 이내여야 한다. 중첩된 문자열과 객체 키의 NUL, 서버가 무한대·NaN으로 해석하는 숫자는 접수 전에 `422 VALIDATION_ERROR`로 거부한다. 예를 들어 `1e1000`도 거부한다. 이 단계에서 작업·파일을 만들거나 요청 키를 소모하지 않으므로 정상 입력으로 같은 키를 다시 사용할 수 있다. 한글·emoji·개행·탭·CR과 실제 NUL이 아닌 리터럴 `\u0000`, 문자열 `NaN` 등은 유지한다. 다른 문서 내용·형식 검증은 기존 worker가 처리한다.

JSON의 중첩 수준이 서버의 저장용 직렬화 한계를 넘는 경우도 접수 단계에서 같은 422로 거부한다. 작업 저장에 사용하는 직렬화를 미리 확인하며, 정상 옵션의 값·필드 설정·요청 해시는 바꾸지 않는다.

`POST /v1/files?filename=회의록.docx`에 원본 바이트, `Content-Type`, UUID `Idempotency-Key`를 보낸다. multipart 업로드가 아니다. 목록·메타데이터·다운로드는 `/v1/files`, `/v1/files/{id}`, `/v1/files/{id}/content`다. 삭제는 휴지통 이동이며 `/restore`로 복원한다. 기본 30일이 지난 삭제 파일은 문서 worker가 바이트를 지우고 작업 이력은 남긴다. 파기 후 복원은 410이다. 기본 파일 제한 10 MB, 사용자 합계 100 MB에 휴지통도 포함한다.

`POST /v1/document-jobs`는 UUID `Idempotency-Key`가 필요하다. 예시:

```json
{"operation":"create","format":"docx","spec":{"title":"회의록","paragraphs":["일정과 담당자를 확인했다."]}}
```

```json
{"operation":"edit","source_file_id":"<본인 파일 UUID>","spec":{"append_paragraphs":["다음 회의는 금요일이다."]}}
```

`GET /v1/document-jobs/{id}`의 `status`, `error_code`, `output_file_id`를 확인한다. 입력 파일은 덮어쓰지 않으며 결과는 새 파일이다. `POST /v1/document-jobs/{id}/cancel`로 대기·실행 중 작업의 결과 게시를 취소한다. `POST .../{id}/retry`는 실패·취소 작업을 새로운 UUID `Idempotency-Key`로 재등록하고 원래 이력을 보존한다. 재시도는 새 작업 ID를 반환하며 같은 재시도 키의 반복 요청은 그 ID를 다시 반환한다. 실행 중인 파서가 즉시 종료되는 것과 결과 저장 취소는 구분한다. 파일·작업·결과 모두 소유자를 검증한다. 파서는 임시 작업 디렉터리와 제한된 subprocess에서 실행하며 시간·메모리·ZIP 확장량·출력량을 제한한다. 긴 읽기 결과는 부분 미리보기로 반환하고 `truncated`, `body_paragraphs_truncated`, `cells_truncated`로 생략을 명시한다. 변환의 `source_truncated`는 추출·미리보기 제한의 영향을 알리며, 원본은 다운로드로 보존한다.

| 형식 | 지원 | 한계 |
|---|---|---|
| TXT/MD/CSV | 읽기·생성·텍스트 편집 | 일반 텍스트 처리 |
| DOCX | 읽기·생성·문단 교체/추가, 중첩 표 텍스트 읽기 | 교체 문단의 인라인 서식 손실 가능. 표 중첩은 64단계까지 |
| XLSX | 읽기·생성·셀 편집 | 수식 재계산·매크로 실행 없음 |
| PDF | 텍스트 읽기·생성·페이지 선택/회전 | OCR, 본문 레이아웃 편집 없음 |
| HWP/HWPX | 텍스트 읽기 | 원본 한글 파일 편집·생성 없음 |
| 변환 | 추출 텍스트를 TXT/MD/DOCX/PDF로 재구성 | 원래 페이지·도형·표 배치를 보존하는 변환 아님 |

DOCX 읽기·텍스트 변환은 셀 내부의 중첩 표도 원래 순서대로 추출한다. 블록·inline 콘텐츠 컨트롤의 표시 텍스트도 추출하며 속성 메타데이터는 제외한다. 읽기용 DOM에서만 wrapper를 풀고 원본 파일과 기존 최상위 문단 편집 번호를 유지한다. 미리보기 한도에서 잘리면 기존 truncated 표기를 유지하며, 과도한 표 중첩은 처리 실패로 분류한다. 문단 편집용 body_paragraphs 번호는 기존처럼 문서 본문의 최상위 문단 기준이다.

HWPX는 지원 paragraph namespace의 같은 문단 run을 연결하고 inline lineBreak·tab 뒤 텍스트, 빈 문단·표 안 문단·구역 순서를 보존한다. 실제 서비스 subprocess로 제어한 XML·ZIP의 읽기·변환을 검증했다.

HWP는 pyhwp의 실제 CLI 진입점을 별도 subprocess에서 호출하며, 누락된 런타임 의존성 six를 명시하고 lockfile에 고정했다. CLI 실행·한국어 출력 전달은 제어한 모듈로, 잘못된 바이너리 거부는 실제 설치 파서로 확인했다. 정상 HWP 원본 fixture를 이용한 전체 추출은 아직 검증하지 않았다. 새 backend 이미지는 갱신된 uv.lock으로 빌드한다.

`POST /v1/speech/transcriptions`에는 지원 오디오 MIME과 원본 바이트를 보낸다. 전사는 채팅 제출을 자동 실행하지 않는다. 무음은 `422 NO_SPEECH`, 제공자 요청 제한은 `503 SPEECH_PROVIDER_RATE_LIMITED`, 시간 초과는 `504 SPEECH_TIMEOUT`으로 구분한다. 전사문은 최대 40,000자를 보존하므로 4,000자 채팅 제한을 넘으면 클라이언트에서 편집하거나 문서로 첨부한다. 브라우저 녹음, RN 권한, 키보드 전환, TTS와 native push는 클라이언트 작업이다. Web Push 연결용 최소 예시는 [service worker 계약](../client-contracts/mori-push-sw.js)에 제공한다.

## 결제·시세·뉴스의 범위

[Toss/KIS 상세 계약](billing-market.md)에 설정과 제공자 근거를 모았다. 웹 정기 결제는 서버가 정한 금액과 customerKey를 사용한다. 빌링키는 암호화해 저장하며, 모호한 통신 실패에서는 기존 주문을 조회한 뒤 처리한다. 웹훅의 성공 문구만으로 Pro를 부여하지 않는다. 해지는 현재 결제 기간 말의 갱신 중단이며 즉시 환불 기능이 아니다. App Store/Play Store 인앱 결제 검증은 별도 구현 대상이다.

KIS 어댑터는 국내 주식의 당일 차트에 완료된 1분봉을 반환한다. 현재 수집 범위는 한국 시간 09:00–15:30이며 특수 개장일·시간 외 거래는 별도 지원 대상이다. 빈 세션은 `as_of=null`과 사유를 반환한다. 국내 주/월·지수·미국 주식 차트와 가격 조회·예약 스냅샷은 완료된 거래일 종가·일봉이다. `interval`, `price_kind`, `as_of_precision`으로 표시를 구분하며 종가를 실시간 가격으로 표시하지 않는다. 자세한 응답과 한도는 [시세 계약](billing-market.md)을 따른다.

수동 뉴스 수집은 180초 기한을 저장한다. 기사 수집·요약 도중 API가 중단되면 기한 만료 후 본인의 `GET /v1/news`에서 `failed`와 `NEWS_REFRESH_INTERRUPTED`로 전환해 재수집할 수 있다. 이전 기사·요약·수집 시각을 보존하고, 만료된 요청의 늦은 결과는 게시하지 않는다. 요약을 기다리는 중간 기사도 조회할 수 있지만 전체 수집 상태는 `loading`이다. 예약 수집은 기존 작업 lease와 worker의 재시도로 복구한다. `0017_news_refresh_deadline`은 기존 loading 중 실행 중인 예약 작업이 같은 generation을 소유하지 않은 행을 다음 조회에서 복구하도록 준비한다.

뉴스 요약은 `MORI_NEWS_SUMMARY_ENABLED=true`일 때 검색 발췌를 근거로 만들며 기사 전체를 읽었다고 표시하지 않는다. 같은 주제의 재수집·요약 실패에는 마지막으로 성공한 기사와 요약을 유지하며 `result_is_stale`로 표시한다. 주제를 바꾸면 이전 주제의 결과를 새 결과로 표시하지 않는다. `feature_status`는 기능의 활성·중지 상태다. 뉴스 카드는 예약 30분 전부터 180분 후까지, 일반 주가 카드는 설정 시각부터 16시까지 표시한다. 사용자가 정한 저녁 주가 일정은 90분 구간을 유지한다. 뉴스·주가 카드의 `builtin_key`와 `detail_url`로 전용 상세 API를 선택한다.

## 배포 순서

1. 새 backend/Hermes 이미지를 빌드·게시하고 digest를 정한다. 이 변경은 이미지 파일과 manifest만 제공하며 서버에 적용하지 않는다.
2. DB·인증·제공자 설정은 서버 Secret에 저장한다. `.env.example`은 키 이름과 기본값만 담는다. `MORI_RUNTIME_MASTER_KEY`, `MORI_BILLING_ENCRYPTION_KEY`는 서로 다른 Fernet 키를 사용하고 분실·임의 교체하지 않는다.
3. `uv run alembic upgrade head` 또는 기존 migration Job으로 `0017_news_refresh_deadline`까지 적용한다. 먼저 API·worker 버전과 migration 호환성을 맞춘다. 알림의 기존 시작 시각은 최초 생성 시각으로 채우며 재시작부터 새 시작 시각을 저장한다.
4. API를 실행한다. Kubernetes 토큰을 마운트하지 않는다. `/health/ready`는 DB 스키마 준비를 확인한다.
5. 필요한 기능을 켜고 `mori worker`를 별도 실행한다. Compose에서는 `docker compose --profile automation up -d --build`를 사용한다. k3s는 [backend-worker.yaml](../../infra/k3s/backend-worker.yaml)의 이미지·Secret 참조를 채운다. 최소 채팅은 `MORI_CHAT_ENABLED=true`, `MORI_CHAT_WORKER_ENABLED=true`가 함께 필요하다.
6. 공용 gateway와 Pro provisioner를 배포한다. provisioner만 제한된 Kubernetes 권한을 갖는다. Knative/PVC 설정과 네트워크 정책을 별도 검증한다.
7. 예약은 `MORI_AUTOMATION_ENABLED`, 알림은 `MORI_PUSH_ENABLED`, 문서는 `MORI_DOCUMENTS_ENABLED`, 결제는 `MORI_BILLING_ENABLED`를 각각 켠다. 각 제공자의 필수 값이 없으면 기능을 켜지 않는다.
8. `/v1/capabilities`에서 `configured`와 worker heartbeat 상태를 확인한다. 설정만 되어 있고 worker가 없으면 정상 실행 중이라고 해석하지 않는다. `mori worker-health`는 설정에서 활성화한 worker만 검사하며 결제 worker도 포함한다. 특정 대상만 확인하려면 `mori worker-health --components chat,billing`처럼 지정한다. 기본 검사에서 활성화된 대상이 없으면 실패로 종료한다.
9. 테스트 계정으로 인증→무료 격리→Pro 배정→cold start→대화 재접속→예약→파일 생성·다운로드→Push를 순서대로 확인한다. 결제는 제공자 테스트 환경부터 진행한다.

## 검증과 남은 운영 확인

자동 테스트는 임시 PostgreSQL에 실제 migration을 적용하고 API·worker를 실행한다. Hermes/Kubernetes/Toss/KIS/전사 HTTP는 제어된 응답으로 검증한다. 사용자 소유권, 중복 요청, 실행 lease, 종료 후 복구, 권한 회수, 배치 저장 롤백, 문서 실제 파싱과 파일 재읽기 등을 검사한다. 공용 gateway 테스트는 실제 자식 프로세스를 띄워 HTTP/SSE 라우팅과 홈 분리를 확인한다.

실제 Harbor 이미지 빌드·pull, k3s Pod 배치·PVC·CNI 격리, GPU 응답, Knative 콜드 스타트 지연, Toss 청구, KIS 계정 권한, 브라우저 Push·모바일 녹음은 해당 환경을 연결한 후 검증해야 한다. API 구현 완료를 이 운영 검증의 완료로 간주하지 않는다.

### 2026-11-03 로컬 검증 기록

- 반복 독립 리뷰 후 임시 PostgreSQL에서 backend 전체 **493개 통과**. migration 전체 downgrade/upgrade와 모델 차이 검사 포함.
- Hermes 테스트 **85개 통과, 1개 건너뜀**. 건너뛴 항목은 해당 테스트 환경에 Trafilatura가 없는 본문 추출 검사다. 공유 gateway 테스트는 통과했다.
- 별도 subprocess에서 XLSX 생성→셀 편집→재읽기, PDF 생성→재읽기 통과. PDF 검사는 로컬 번들 글꼴을 사용했으며 컨테이너의 한글 글꼴 렌더링 검증을 대신하지 않는다.
- Ruff 검사·포맷, uv lock 확인, Compose 설정 파싱, 기존 runtime manifest 검사, OpenAPI 생성·일치 검사 통과.
- Swagger/Scalar 응답과 파일·음성 바이너리 업로드 명세 확인. 등록 경로 85개.
- 테스트 DB는 종료했다. PoC/plan 브랜치의 기존 변경 사항은 유지했으며 운영 배포·결제·commit·push는 수행하지 않았다.

화면별 최신 대응은 [PoC 대조표](poc-parity-map-0.9.md), 추가 점검에서 발견한 문제와 수정 근거는 [PoC 기능 재점검 기록](poc-coverage-review-0.9.md)에 정리했다. 아래는 같은 날짜의 후속 전체 대조 결과다.

### PoC 전체 대조 후 추가 검증

- backend 전체 **567개 통과**. 앞선 493개에 화면 계약·새 채팅 동작·국내 분봉 회귀 74개를 추가했다. 임시 PostgreSQL에 `0016_reminder_started_at`까지 적용하고 기존 스키마 왕복·모델 차이 검사도 통과했다.
- 대시보드 최근 기록은 최대 5개로 맞췄다. 알림은 `started_at`, 대화 목록은 `last_message/last_activity_at`으로 화면 복원에 필요한 값을 반환한다.
- 일반 대화에서 뉴스 주제·예약·수집과 주가 종목·예약·조회가 기존 기능 저장소로 연결된다. 뉴스 조회만 할 때 기존 예약·기능 버전을 바꾸지 않는다.
- 주가 설정은 종목과 예약을 원자적으로 저장한다. 국내 당일 차트는 KIS 1분봉이며 정확한 데이터 범위·빈 결과 처리는 [시세 계약](billing-market.md)을 따른다.
- Ruff 검사·포맷, OpenAPI 생성·일치, diff 검사 통과. 기존 외부 라이브러리 deprecation 경고 2건은 남아 있다.
- Hermes 코드·이미지·클러스터는 이번 후속 대조에서 변경하지 않았다. 실제 GPU 모델이 새 뉴스·주가 액션을 선택하는지와 실제 KIS 계정의 응답은 배포 환경에서 검증해야 한다. PoC/plan의 기존 작업 상태는 유지했고 운영 배포·결제·commit·push는 하지 않았다.

### PoC 두 번째 전체 대조 후 추가 검증

- backend 전체 **589개 통과**. 목록 메타데이터·기능 조회/재사용·메모 편집/되돌리기 회귀 검사 22개를 추가했다. 기존 deprecation 경고 2건은 동일하다.
- `/library`와 대시보드 최근 기록은 파일 이름·크기, 기능 아이콘, 체크 개수·완료 개수를 반환한다. 시간 미지정 기능의 JSON `null` 예약으로 대시보드가 실패하던 경로도 수정했다.
- 일반 대화의 `feature_lookup`은 현재 문맥에 전달한 사용자 기능만 조회하고 상태와 상세 참조를 반환한다. 중지·초안 기능을 실행하지 않으며, 동명 기능 생성 요청도 기존 정의와 권한을 덮어쓰지 않는다.
- 오늘 메모 정리는 마지막 내용 저장 시각을 사용한다. 삭제·복원은 그 시각을 유지하고, 지연된 예약은 원래 회차의 날짜·시간대로 메모를 고른다. 예약 뉴스 완료 대화에서도 브리핑 상세로 이동할 수 있다.
- 교차 리뷰, Ruff·포맷, OpenAPI 생성·일치, diff 검사 통과. 추가 migration은 없다. 실제 UI 연결·모델 선택 품질·제공자·클러스터 검증은 별도이며, PoC·plan·운영 배포·commit·push는 이번 대조에서 변경하지 않았다.

### PoC 세 번째 전체 대조 후 추가 검증

- backend 전체 **595개 통과**. 주차 조회와 예약 주가의 결과 이동에 대한 회귀 검사 6개를 추가했다. 기존 경고 2건 외 실패는 없다.
- 주차 저장·조회는 같은 `parking` 참조를 반환한다. 예약 주가에는 최신 `stock` 스냅샷 참조와 해당 회차의 `feature_result`를 함께 남긴다. 실패·취소·종목 변경 시 성공 참조를 게시하지 않는다.
- 독립 교차 리뷰, Ruff·포맷, OpenAPI 생성·일치, diff 검사 통과. 새 migration은 없다. 이미 저장된 과거 이벤트는 재작성하지 않는다.
- 다른 PoC 흐름에서는 추가 서버 누락을 확정하지 못했다. 실제 PoC에 없는 대화 삭제·복원 표기를 정정하고 주차·시간 구간의 연결 규칙을 [화면별 대조표](poc-parity-map-0.9.md)에 명시했다. 실제 UI·제공자·클러스터 통합 검증은 남아 있다.


### PoC 네 번째 전체 대조 후 추가 검증

- backend 전체 **603개 통과**, 기존 외부 라이브러리 경고 2건. 수동 뉴스 수집 중단·늦은 응답·재수집·사용자 분리·예약 작업 분리·기존 데이터 변환 회귀 8개를 추가했다.
- 수동 뉴스 수집의 loading 고착을 180초 기한과 조회 시 복구로 보완했다. 이전 브리핑을 보존하고 만료된 결과의 게시를 차단한다. 예약 수집은 기존 worker lease를 사용한다.
- 배포 시 `0017_news_refresh_deadline`을 적용한다. 같은 generation을 실행 중인 예약 작업을 보존하면서 과거 수동 loading은 복구한다. 임시 DB의 migration 왕복·모델 비교와 독립 리뷰, Ruff·포맷·OpenAPI 일치·diff 검사를 통과했다.
- 다른 화면 흐름에서는 새 서버 누락을 확정하지 못했다. PoC 연결·실제 제공자·모바일·Knative 운영 검증은 별도이며 이번에는 코드와 문서만 갱신했다.


### 독립 코드 리뷰 후 추가 검증

- backend 전체 **623개 통과**. 결제 취소 경계 6개, 최신 시세의 응답 순서 9개, DOCX 중첩 표 3개, HWP 파서 진입점·실패 2개를 추가했다. 기존 경고 2건 외 실패는 없다.
- 초기 결제 취소 상태 고착과 이전 주문의 새 구독 갱신 오염, 오래된 시세의 최신 snapshot 덮어쓰기, DOCX 중첩 표 내용 누락, HWP 파서 미실행·six 누락을 수정했다.
- 교차 리뷰와 Ruff·포맷·OpenAPI 일치·uv.lock 오프라인 일치·migration 왕복·모델 비교를 통과했다. 새 migration은 없다. HWP 의존성이 추가되어 갱신된 lockfile로 backend 이미지를 빌드해야 한다.
- 정상 HWP 원본 전체 추출과 실제 제공자·클러스터 통합 검증은 별도다. 수정 조건과 검증 한계는 [코드 리뷰 기록](poc-coverage-review-0.9.md)에 남겼다.


### 후속 독립 코드 리뷰 검증

- backend 전체 **644개 통과**. 일반 시세의 미래 timestamp 거부·기존 오염 데이터 복구·정상 제공자 시각 보호 17개, HWPX 서식 run·inline control 뒤 본문·문단/표/구역 순서·잘림 4개를 추가했다.
- 일반 시세는 서버 시각보다 5분 초과 미래의 as_of/observed_at을 거부하며, 기존 오염 snapshot도 원래 서버 수집 시각을 기준으로 정상 값으로 복구한다. 유효한 as_of 순서는 계속 보호한다.
- HWPX는 같은 문단의 run을 이어 붙이고 줄바꿈·탭 뒤 본문을 보존한다. 제어한 실제 namespace XML·ZIP을 서비스 subprocess로 읽기·변환 검증했으며 정상 원본 전체 검증은 별도로 남아 있다.
- 교차 리뷰·Ruff·포맷·OpenAPI 일치·migration 왕복·모델 차이·diff 검사를 통과했다. 기존 외부 라이브러리 경고 2건은 동일하다. 새 migration·의존성·API 스키마 변경은 없다.


### DOCX 콘텐츠 컨트롤 리뷰 검증

- backend 전체 **650개 통과**. 블록·inline·중첩 콘텐츠 컨트롤, 셀 안 표, 링크·탭·줄바꿈, TXT/DOCX 변환, 원본·편집 번호·전체/문단 잘림 보존 회귀 6개를 추가했다.
- 콘텐츠 컨트롤 안의 표시 본문이 누락되는 문제를 읽기 전용 DOM에서 해결했다. 속성 메타데이터는 포함하지 않고 원본과 기존 편집 번호를 유지한다.
- 독립 교차 리뷰와 Ruff·포맷·OpenAPI 일치·migration 왕복·모델 차이·diff 검사를 통과했다. 기존 경고 2건은 동일하다. 새 migration·의존성·API 스키마 변경은 없다.


### 예약 경계·결제 입력 리뷰 검증

- backend 전체 **664개 통과**. 예약 날짜·최종 시간대 검증, 기존 불량 revision 격리·조회·실제 수정 후 복구 12개와 결제의 비ASCII 고객 키·상태 보존·정상 재시도 2개를 추가했다.
- UTC 변환 범위를 벗어나는 예약을 저장 전에 422로 거부하며, 기존 불량 예약이 다른 사용자의 실행을 중단하지 않도록 격리한다. 기존 항목 조회·과거 버전·같은 주제 뉴스 재수집과 DST 정책은 유지한다.
- 비ASCII 고객 키로 결제 완료를 요청해도 서버 오류 대신 기존 고객 불일치 422를 반환한다. 주문·구독·등급·체크아웃은 보존한다.
- 독립 교차 리뷰와 Ruff·포맷·OpenAPI 일치·migration 왕복·모델 차이·diff 검사를 통과했다. 기존 경고 2건은 동일하다. 새 migration·의존성·API 스키마 변경은 없으며 운영 호출·배포·commit·push는 수행하지 않았다.


### 일정·알림 저장 범위·갱신 토큰 재검토

- backend 전체 **682개 통과**. 날짜 입력·실패 시 상태 보존·정상 경계 저장/재조회·과거 응답 재생·기존 행 복구 16개와 갱신 토큰 인코딩 오류·기존 세션 보존 2개를 추가했다.
- 일정·알림의 UTC 범위 밖 저장과 종일 일정 변환·연장 오류를 422로 처리한다. 기존 오염 행은 소유권·revision 확인 후 정상 PUT으로 복구할 수 있으며 과거 생성 응답은 유지한다.
- 잘못된 SecretStr 갱신 토큰은 해시 계산 전에 401로 거부한다. 정상 토큰 회전과 기존 세션은 유지한다.
- 수정 후 다른 에이전트의 교차 검토와 통합 master 재검토에서는 새 확정 결함이 없었다. 독립 PostgreSQL 검사로 채팅·예약 batch의 중간 flush 후 전체 rollback·재시도도 확인했다.
- Ruff·포맷·OpenAPI 일치·migration 왕복·모델 차이·diff 검사를 통과했다. 기존 경고 2건 외 실패는 없으며 새 migration·의존성·API 스키마 변경은 없다. 실제 제공자·클러스터·모바일 통합은 운영 검증 항목이고 commit·push는 수행하지 않았다.


### DOCX 표시 필드·알림 입력·제공자 응답 재검토

- backend 전체 **700개 통과**, Hermes **90개 통과·1개 건너뜀**. backend 회귀 18개와 Hermes 문서 worker 회귀 5개를 추가했다. 기존 외부 라이브러리 경고 2건과 Trafilatura 미설치 skip은 동일하다.
- DOCX의 콘텐츠 컨트롤·단순 필드에 저장된 표시값을 읽고 변환한다. 원본·편집 번호·잘림과 명령 미실행을 유지하며 선택형 Hermes 문서 도구도 같은 본문/표 순서와 중첩 처리를 적용했다.
- 알림 기기 이름의 NUL은 저장 전 422로, 비정상 소셜 제공자 응답은 기존 oauth_failed 복귀로 처리한다. 정상 Unicode·기존 상태·새 요청 재시도는 보존한다.
- 다른 리뷰어의 교차 검토와 통합 master 재검토에서 추가 확정 결함은 없었다. Ruff·포맷·OpenAPI 일치·migration 왕복·모델 차이·diff 검사도 통과했다. 새 migration·의존성·API 스키마 변경은 없다.
- Hermes 변경의 운영 반영에는 이미지 재빌드가 필요하다. 이번에는 이미지 빌드·배포·실제 제공자 호출·commit·push를 하지 않았다. 실제 Linux 자원 제한·모델·클러스터 통합과 정상 HWP/HWPX 원본 전체 검증은 운영 단계에서 확인한다.


### 병합 셀·검색 입력 재검토

- backend 전체 **706개 통과**, Hermes **91개 통과·1개 건너뜀**. backend 회귀 6개와 Hermes 병합 방향 subtest 3개를 추가했다. 기존 경고 2건과 Trafilatura 미설치 skip은 동일하다.
- DOCX의 병합된 실제 XML 셀은 한 번만 읽고 나머지 grid 위치는 빈칸으로 남긴다. 별도 셀의 같은 문구·정상 문단 반복·중첩 표·원본·편집 번호·잘림 경계는 보존한다. backend와 Hermes 모두 적용했다.
- 메모·기록·대화 검색어의 NUL을 DB 조회 전에 422로 거부한다. 기존 200자·빈값·Unicode·공백·리터럴 특수문자 검색과 사용자 격리를 유지하고 OpenAPI 입력 제약도 갱신했다.
- 수정 후 교차 리뷰와 통합 master 재검토에서 추가 확정 결함은 없었다. Ruff·포맷·OpenAPI 재생성/일치·migration 왕복·모델 차이·diff 검사를 통과했다. 새 migration·의존성·API 경로·응답 형식 변경은 없다.
- Hermes 변경은 이미지 재빌드·배포 후 운영에 반영된다. 이번에는 실제 제공자·클러스터 호출·이미지 빌드·배포·commit·push를 수행하지 않았다.


### 문서 작업 JSON 입력 재검토

- backend 전체 **716개 통과**. 문서 spec의 중첩 NUL·객체 키 NUL·비유한 숫자, 실패 후 같은 키 재시도·정상 출력 bytes·기존 worker 검증을 확인하는 회귀 10개를 추가했다. 기존 경고 2건 외 실패는 없다.
- DB가 저장할 수 없는 JSON 값은 접수 전 422로 거부한다. 정상 Unicode·리터럴 역슬래시 u0000·문자열 NaN·유한수·boolean/null과 기존 200KB 한도·request hash를 유지한다.
- 독립 PostgreSQL 검사 7개와 두 리뷰어의 교차/통합 검토에서 추가 확정 결함은 없었다. 직접 API와 실제 chat worker의 같은 입력 검증·작업/파일/성공 이벤트 미생성·정상 재시도를 확인했다.
- Ruff·포맷·OpenAPI 일치·migration 왕복·모델 차이·diff 검사를 통과했다. 새 migration·의존성·API 경로·OpenAPI 필드 변경은 없다. Hermes·PoC·plan은 이번에 수정하지 않았으며 운영 호출·빌드·배포·commit·push를 수행하지 않았다.


### 문서 옵션 직렬화 경계 재검토

- backend 전체 **726개 통과**. 실제 HTTP의 깊은 list/dict 거부·정상 경계 저장/재생·같은 키 재시도와 모델 응답 단일/batch 분류 회귀 10개를 추가했다. 기존 경고 2건 외 실패는 없다.
- 문서 옵션이 서비스의 JSON 직렬화 한계를 넘으면 저장 전 422로 처리한다. 실제 저장에 사용하는 serializer를 확인하며 기존 200KB·NUL·비유한수·형식 검증과 요청 해시를 유지한다.
- 독립 PostgreSQL 교차 검사 7개와 두 리뷰어의 통합 정적 검토에서 추가 확정 결함은 없었다. 문서·첨부 관련 root 검사 45개도 통과했다.
- Ruff·포맷·OpenAPI 일치·migration 왕복·모델 차이·diff 검사를 통과했다. 새 migration·의존성·API 경로·OpenAPI 필드 변경은 없다. Hermes·PoC·plan은 수정하지 않았으며 운영 호출·이미지 빌드·배포·commit·push를 하지 않았다.


### 추가 독립 검토 결과

- 세 서브 에이전트가 실행·데이터·계정/런타임 범위를 다시 검토했으며 새 확정 결함은 없었다. 제품 코드·검사·API 계약은 바꾸지 않고 검토 기록만 갱신했다.
- Ruff·포맷·OpenAPI 일치·diff 검사를 다시 통과했다. 전체 동적 검사는 반복하지 않았고 직전 backend 726개 통과·Hermes 91개 통과/1개 skip은 이전 검증 결과다.
- 실제 제공자·클러스터·모바일·정상 HWP/HWPX 원본 통합 검증은 별도다. PoC·plan의 기존 상태를 유지했고 이미지 빌드·배포·commit·push를 수행하지 않았다.


### 최종 커밋 전 검증

- 2026-11-03 세 서브 에이전트의 최종 독립 리뷰에서 새 확정 결함이 없었다. 이번 리뷰에 따른 제품 소스 수정은 추가하지 않았다.
- 이번에 전체 검사를 다시 실행해 backend **726개 통과**, Hermes **91개 통과·1개 skip·43 subtest 통과**를 확인했다. 기존 deprecation 경고 2건과 Trafilatura 미설치 skip은 동일하다.
- Ruff·포맷·OpenAPI 일치·uv.lock 오프라인 일치·migration 왕복·모델 차이·diff 검사를 통과했다. 누적 기능·회귀 수정·운영 예시·계약 문서를 의미 단위로 분할해 커밋한다. 실제 제공자·클러스터·모바일 통합·정상 HWP/HWPX 원본 전체 검증과 이미지 빌드·배포는 별도다.
