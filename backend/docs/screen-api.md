# PoC 화면 연결 API — 0.7.0

기준: 2026-10-02, PoC의 5개 탭과 화면 기획서. 주차 표시 방식과 문서 10MB 지원을 추가했다. `master` 백엔드에 구현했으며 PoC의 localStorage 코드를 서버 호출로 교체하거나 운영 k3s에 배포한 것은 아니다. API 실행 후 [Scalar](http://localhost:8000/scalar), [Swagger UI](http://localhost:8000/docs) 또는 [OpenAPI JSON](openapi.json)에서 입력·응답 타입을 확인한다. 웹 문서 상단에 인증·멱등 키·revision·SSE 사용법을 함께 표시한다.

## 화면별 연결

| 화면 | API | 서버 동작 |
| --- | --- | --- |
| 대시보드 시간 버튼 | `GET /v1/dashboard?hours=0\|3\|5\|24` | 현재 카드·예정 항목을 시간대 그룹으로 조회 |
| 기록·보관함 | `GET /v1/library?kind=note\|document\|feature_result` | 메모·원문 문서·기능 실행 결과를 최근 갱신 순서로 합침 |
| 메모 | `GET/POST /v1/notes`, `GET/PUT/DELETE /v1/notes/{id}` | 검색·작성·수정·삭제 |
| 캘린더 | `GET/POST /v1/calendar/events`, `GET/PUT/DELETE /v1/calendar/events/{id}` | 월·주·일 기간 조회, 직접 입력과 AI 입력이 같은 기록 사용 |
| 알림 상세 | `GET/POST /v1/reminders`, `GET/PUT/DELETE /v1/reminders/{id}`, `POST /{id}/cancel` | 목표 시각 보관·연장·취소. 푸시 전송은 미연결 |
| 삭제 되돌리기 | 위 메모·일정·알림·문서의 `POST /{id}/restore` | 삭제 응답의 revision을 보내 복원 |
| 기능 탭 | `GET /v1/feature-catalog`, `GET/POST /v1/features` | 기본 기능 목록과 사용자별 기능 정의 |
| 기능 상세·편집 | `GET/PUT /v1/features/{id}`, `POST /{id}/state` | 설명·수행할 일·참고 내용·시간·아이콘, 활성/중지 |
| 기능 버전·결과 | `GET /v1/features/{id}/versions/{version}`, `GET /{id}/results`, `GET /v1/feature-results/{id}` | 시작 시 고정한 정의 버전과 실제 채팅 실행 결과 |
| 대화 목록 | `GET /v1/conversations?q=…&limit=50&offset=0` | 제목·메시지·답변 검색, 고정 우선·최근 활동 순서 |
| 대화 정리 | `GET/PATCH/DELETE /v1/conversations/{id}` | 제목 변경·고정·목록에서 삭제. 실행 중 삭제는 409 |
| 채팅·음성 전송 | 기존 `POST /v1/conversations/{id}/messages` | SSE 작업 상태와 최종 답변. 음성은 인식한 텍스트를 같은 경로로 전송 |
| 마이 · 사용자 정보 | `GET/PATCH /v1/me` | 소셜 가입 정보 조회·이름 수정, revision 충돌 검사 |
| 마이 · 테마 | `GET/PUT /v1/me/settings` | system/light/dark 테마만 저장 |
| 마이 · 요금제 | `GET /v1/plans`, `GET /v1/me/subscription` | 무료·Pro 안내, 이용권과 결제 상태 구분. 실제 결제·해지는 준비 중 |
| 문서 보관 | `GET/POST /v1/documents`, `GET/DELETE /v1/documents/{id}`, `GET /{id}/download` | TXT/MD/CSV 원문 저장·다운로드 |
| 주차 | `POST /v1/parking-records`, `GET /v1/parking-records/latest` | 위치·출근용/외부·상시/시간 표시 저장·최신 조회 |
| 로그인·Pro | 기존 계약 유지 | 네이버·카카오, 최고 관리자 승인 |

표의 `/{id}/…`는 같은 행의 리소스 경로 뒤에 붙인다. 기능 실행은 별도 검색 API를 만들지 않고 채팅 진입점을 사용한다. `stock` 기능 정의는 저장할 수 있지만 시세 공급자가 없어 실행하면 `503 MARKET_DATA_NOT_CONFIGURED`다. 기본 기능 카탈로그 조회는 사용자별 설정을 임의로 생성하지 않는다.

## 공통 규칙

- `/v1`의 사용자 데이터는 기존 소셜 로그인 Bearer 토큰으로 인증한다. 요청 본문으로 user_id·등급·Hermes URL을 선택할 수 없다. 다른 사용자 ID는 404로 응답한다.
- 신규 기록 생성(`notes`, `calendar/events`, `reminders`, `documents`, `features`)에는 UUID `Idempotency-Key`가 필수다. 동일 경로·사용자·키·정규화 입력은 최초 응답을 돌려준다. 같은 키에 다른 입력은 409다. 이후 편집된 데이터를 옛 생성 재시도가 덮어쓰지 않는다. 재응답도 201이며 현재 내용을 보려면 GET을 사용한다.
- 편집은 **PUT 전체 교체**다. 조회 값 중 쓰기 필드와 `revision`을 보낸다. 생략한 선택 필드는 기본값으로 돌아간다. `id`, `created_at`, `status` 등 읽기 전용 필드는 보내지 않는다. 대화는 부분 PATCH다.
- 신규/조회 revision은 1부터 시작하고 수정 시 증가한다. 충돌은 `409 REVISION_CONFLICT`다. 설정이 아직 없을 때만 revision=0이다. DELETE에는 `?revision=N`, 취소·복원·기능 상태 변경에는 `{"revision":N}`을 보낸다. 기능 상태에는 `status`도 필요하다.
- 메모·일정·알림·문서는 소프트 삭제하며 복원은 삭제 응답의 최신 revision으로 호출한다. 삭제된 항목은 목록·상세·대시보드에서 제외한다. 대화는 삭제 후 조회할 수 없고, 대화의 삭제 복원·영구 파기는 이번 API에 없다.
- 목록은 limit/offset으로 순회한다. 기본 50, 최대 100이며 일정은 기본 100, 최대 500이다. `library`는 `items`, `has_more`, `next_offset`을 제공한다. 나머지 도메인 목록은 배열이다. 동시 추가/수정 중 offset 페이지가 이동할 수 있으므로 ID로 중복을 제거한다.
- 검증 실패는 `422 VALIDATION_ERROR`, 미래가 아닌 알림은 `422 REMINDER_IN_PAST`다. 일반 오류 응답은 `{"error":{"code":"…","message":"…"}}`다. SSE 시작 후의 오류는 `run.failed`로 전달한다.

## 대시보드와 시간

`hours=0`은 지금 표시할 카드, 3·5·24는 지금부터의 탐색 범위다. 하루는 자정까지가 아닌 24시간이다. 서버 시각은 `server_time`, 조회 기준은 `from`, 종료는 `until`이다. 선택적인 `at`은 오프셋이 포함된 조회 기준 시각(1970~2200년)이며 저장 시계나 예약을 변경하지 않는다.

응답은 `groups[].items[]`에 안정적인 occurrence `key`, `resource_id`, `kind`, 제목/설명, `at`, `show_from/show_until`, `current`, `action`, `availability`, `detail_url`을 제공한다. `action`은 `display`, `appointment`, `notify`, `execute`로 표시·약속·알림·작업 시각을 구분한다.

- 이미 표시 중인 항목은 current 그룹에, 이후 항목은 사용자 시간대의 6시간 구간에 들어간다. 미래 기준은 시작 포함·종료 제외다.
- 현재 표시 정책: 일정 시작 150분 전부터 종료까지, 알림 목표 90분 전부터 목표 순간까지다. 새 주차 기록은 상시 또는 지정한 요일·시각·기간에 표시한다. 기능 시간 설정은 기준 시각부터 90분 동안 보인다.
- 주차는 [주차 계약](parking-api.md)의 purpose/display_mode/display_schedule을 사용한다. 상시 표시의 `show_until`은 null이며 임의 만료 시각을 만들지 않는다. 최신 위치 하나를 표시하고 구간 도중 저장하면 바로 보인다. 0007 이전 기록만 기존 출근 문맥을 사용한다.
- 출근 시각은 기본 null이다. 입력 근거 없이 09:00 출근이나 습관 학습을 가정하지 않는다. 이 정보는 내부 비서 문맥이며 마이 설정 API로 변경하지 않는다. 기존 저장값은 보존하고, 새 사용자 문맥의 생성·학습 연결은 별도 작업이다. `commute_days`는 월요일=0…일요일=6이며 주차 카드가 표시되는 **출근 날짜** 기준이다. 자정 이전에 시작하는 표시도 처리한다.
- 한 번 실행 설정에는 실제 날짜가 필요하다. 날짜 없는 ‘한 번’을 매일 반복으로 바꾸지 않는다. timezone과 daily/weekdays 반복을 저장하며 DST에 없는 시각은 건너뛰고 중복 시각은 첫 번째를 사용한다.
- 중지된 기능, 취소된 알림, 삭제된 기록은 제외한다. 조회는 Hermes 호출, 뉴스 수집, 기능 결과 생성, 예약 완료 갱신을 하지 않는다.
- 실행 예약은 `automation_not_configured`, 알림은 `delivery_not_configured`로 반환한다. 미래 결과가 이미 준비됐다는 뜻이 아니다. 알림 목표가 지나도 서버가 delivered로 바꾸지 않는다.
- 최대 카드 수는 기본 200/최대 500이다. 도메인별 후보는 1,000개까지 읽으며 제한에 걸리면 `truncated=true`를 반환한다. 대량 목록은 일정·기능 API로 조회한다. `next_refresh_at`은 60초 후 재조회 권고이며 이벤트 전달 보장은 아니다.
- `recent_records`는 보관함 최신 3개다. 최근 대화는 프론트가 conversations 목록을 별도로 사용한다. 마이에서 대시보드 표시 여부를 수정하지 않는다.

## 직접 작성 예시

API 기본 주소와 기존 소셜 로그인으로 발급받은 토큰을 사용한다. 토큰 우회나 새 사용자 생성 기능은 추가하지 않았다.

```sh
export MORI_API_BASE='http://127.0.0.1:8000'
# MORI_ACCESS_TOKEN은 기존 로그인에서 받은 값
curl --fail-with-body "$MORI_API_BASE/v1/notes" \
  -H "Authorization: Bearer $MORI_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(python3 -c 'import uuid; print(uuid.uuid4())')" \
  --data '{"title":"내일 챙길 것","body":"우산과 충전기"}'

curl --get --fail-with-body "$MORI_API_BASE/v1/calendar/events" \
  -H "Authorization: Bearer $MORI_ACCESS_TOKEN" \
  --data-urlencode 'from=2026-10-01T00:00:00+09:00' \
  --data-urlencode 'until=2026-11-01T00:00:00+09:00'

curl --fail-with-body "$MORI_API_BASE/v1/dashboard?hours=24" \
  -H "Authorization: Bearer $MORI_ACCESS_TOKEN"
```

일정 작성 필드는 다음과 같다. 시작/끝은 오프셋을 포함해야 하며 종료는 시작 이후다. 서로 겹치는 일정도 저장할 수 있다. 조회는 `[from, until)`에 **걸치는** 일정을 반환해 전날 시작·다음 날 종료 일정을 놓치지 않는다. 최대 조회 기간은 366일이다. 종일 일정은 지정 시간대의 자정~마지막 날 다음 자정(끝 제외)으로 보낸다. 반복 개인 일정과 반복 예외는 아직 지원하지 않는다.

```json
{
  "title": "모리 회의",
  "starts_at": "2026-10-01T14:00:00+09:00",
  "ends_at": "2026-10-01T15:00:00+09:00",
  "timezone": "Asia/Seoul",
  "category": "work",
  "place": "온라인",
  "memo": "화면 기획 검토",
  "all_day": false
}
```

알림 +5분은 현재 target_at에 5분을 더한 값과 revision을 PUT한다. 서버에서 새로운 ‘지금+30분’을 계산하지 않는다. 취소는 `/cancel`이며, 취소한 알림의 목표 시각을 수정해도 자동 재개하지 않는다. 새 알림을 생성해야 한다. 프론트의 남은 시간은 target_at과 서버 시각 기준으로 계산한다.

## 내 기능과 채팅

`FeatureCreate`의 title은 생략하면 ‘나만의 기능’이다. description/work/reference/schedule은 선택이다. work가 비어 있으면 draft이고 실행·활성화가 불가능하다. 아이콘은 6개 기본 키만 지원하며 온라인 이미지 수집은 하지 않는다. `builtin_key`는 뉴스/주가 설정을 연결할 때 사용하며 사용자당 각 1개다.

```json
{
  "title": "퇴근 정리",
  "description": "오늘의 생각을 내일의 할 일로",
  "work": "오늘 작성한 메모를 읽고 내일 할 일 목록을 정리해줘",
  "reference": "핵심 내용을 5개 이내로 작성",
  "icon": "note",
  "schedule": {"time":"19:00", "timezone":"Asia/Seoul", "repeat":"weekdays"}
}
```

저장은 정의·버전과 시간 설정을 보관한다. Hermes cron 등록이나 Knative prewarm을 수행한 것은 아니다. `automation_status=not_configured`이며 화면에서 자동 실행 성공이라고 표시하면 안 된다. 시간을 지정하지 않으면 필요할 때 실행한다.

자연어는 기존 채팅으로 보낸다. Hermes는 내 기능 목록을 보고 `feature_run`을 제안할 수 있고, Mori가 소유자·활성 상태·버전을 확인한 뒤 해당 정의와 오늘 메모를 넣어 다시 호출한다. 선택은 한 번만 허용한다. 기능 화면의 ‘지금 실행’은 같은 채팅 body에 `feature_id`를 지정한다.

```json
{"message":"퇴근 정리를 실행해줘", "feature_id":"기능 UUID"}
```

- 채팅의 작업 제안은 기존 주차 저장/조회 외 메모·일정·알림 목표·사용자 기능 생성으로 확장했다. 직접 입력과 같은 도메인 저장을 사용하고, 저장과 성공 이벤트를 한 트랜잭션으로 commit한다.
- 모호한 시간은 질문하도록 지시한다. 일정의 소요 시간 미지정은 60분이다. 한 번의 최종 제안은 하나의 저장 동작이다. 주차 저장과 알림 요청이 함께 있으면 주차를 저장하고 별도 알림은 예약하지 않았다고 알린다. 자연어 수정·삭제는 직접 편집 화면을 안내한다.
- 선택된 사용자 기능 실행은 허용된 웹 도구를 활용한 **텍스트 결과 작성**이다. 임의 코드 실행·파일 수정·도메인 추가 저장 권한을 주지 않는다. 오늘 메모는 요청 접수일 기준 사용자 시간대로 최대 20개/각 본문 2,000자이며 잘린 상태를 문맥에 알린다. 기능 자동 선택 목록은 활성 기능 최대 50개이며 나머지는 명시적 feature_id로 실행할 수 있다.
- 결과에는 feature ID, 시작 시 feature_version, run ID와 텍스트를 저장한다. 이후 기능을 바꿔도 과거 결과의 버전은 변하지 않는다. 일반 대화의 reply를 매번 기능 결과로 저장하지 않는다.
- `feature.selected`와 `result.saved` SSE가 추가된다. `action.completed`/`result.saved`의 `result_ref`에 상세 경로를 제공한다. 메시지 기록의 `result_refs`로 다시 연 대화에서도 결과 링크를 복원한다. 표시하는 것은 실제 작업 이벤트이며 모델의 비공개 추론이 아니다.
- 웹 검색·본문 도구의 선택은 Hermes가 담당한다. 별도 프론트 웹 검색 API는 재도입하지 않았다. 공용 Hermes의 단일 테스트 사용자 제한과 서버 설정 기반 Pro runtime 선택은 그대로 유지한다.

## 문서와 외부 기능의 현재 범위

문서는 filename과 text를 JSON으로 보내는 원문 보관 API다. text의 UTF-8 크기 **10,000,000바이트(10MB) 이내** TXT/MD/CSV만 받고 본문의 앞뒤 공백도 보존한다. JSON 헤더·파일명 등은 원문 크기에 포함하지 않는다. 다운로드는 항상 첨부 text/plain이다. 실제 AI 요약·DOCX/XLSX/HWP/PDF 업로드·변환은 아직 연결하지 않았다. Hermes 이미지에 문서 라이브러리가 있는 것과 사용자 문서 서비스가 연결된 것은 별개다.

0.7.0의 `GET /v1/documents`는 id/title/filename/size_bytes/revision/created_at/updated_at/deleted_at/processing을 반환하며 text는 제외한다. 원문은 `GET /v1/documents/{id}` 또는 download에서 받는다. 생성·삭제·복원 응답은 기존 DocumentRead를 유지한다. 보관함·대시보드 최근 기록은 DB에서 160자까지만 읽어 목록 조회에 큰 원문을 전송하지 않는다. 프론트는 목록 응답의 text 대신 상세 API를 사용해야 한다.

뉴스는 검색 가능한 Hermes와 연결한 기능을 수동으로 실행하여 텍스트 결과를 보관할 수 있다. 정기 수집·기사별 구조화 데이터·가격 공급자·휴장/지연 시세·OS 알림·기기 토큰·결제는 이번 구현에 없다. Pro 권한은 기존 최고 관리자 승인 방식이다.

## 적용과 검증

새 API 이미지와 `0007_parking_display`까지의 마이그레이션이 필요하다. Hermes 이미지 변경은 필요하지 않지만 새 작업 입력은 실제 모델로 확인해야 한다. 운영 Secret은 기존 방식으로 유지한다. 파일 요청을 통과시키는 프록시에는 JSON 인코딩·메타데이터를 포함할 수 있도록 원문 10MB보다 큰 body 한도가 필요하다.

```sh
cd backend
uv sync --frozen
uv run alembic upgrade head
uv run uvicorn mori.main:create_app --factory --host 127.0.0.1 --port 8000 --no-access-log
```

마이그레이션은 기존 사용자·주차·대화를 보존하고 신규 테이블 및 대화 메타데이터를 추가한다. 0004로 되돌리면 이번 신규 기록/정의/결과와 대화의 고정·삭제 메타데이터는 제거된다. 삭제된 대화가 다시 보일 수 있으므로 운영 데이터가 생긴 후 다운그레이드는 데이터 정책 검토가 필요하다.

0007에서 0006으로 내리면 새 주차 용도·표시 설정이 삭제되며 재업그레이드해도 복원되지 않는다. 기존 위치·시각·요청 키·해시는 유지하고 기존 출근 표시 방식으로 처리한다. `/health/ready`는 새 주차 컬럼을 확인하므로 0007 미적용 DB에는 503이다.

검증은 실제 PostgreSQL의 별도 테스트 DB에서 마이그레이션/롤백, 인증·소유권, 동시 멱등 생성, 수정 충돌, 삭제 복원, 날짜 경계, 대시보드의 읽기 전용 계산, 문서 원문과 다운로드, 채팅 저장 및 기능 선택/결과를 확인한다. Hermes HTTP는 MockTransport로 대체하므로 실제 GPU 모델의 새 JSON 계약 준수와 k3s 왕복은 배포 후 별도 검증이 필요하다.

0.7.0 검증(2026-10-02): PostgreSQL 18의 별도 테스트 DB에서 전체 204개 통과. 기존 기록과 재전송 해시 보존·스키마 불일치 readiness, 상시 카드의 동일 key, 요일/자정/종료 경계, 채팅 표시 설정 저장, 10,000,000바이트 원문의 재전송·다운로드·사용자 격리와 초과 거부를 확인했다. Ruff와 OpenAPI 일치 검사도 통과했다. 이번 변경의 이미지 빌드·Harbor push·운영 배포·실제 GPU 호출은 수행하지 않았다.

2026-09-30 검증 결과: 전체 테스트 176개 통과, 대화 결과 링크 보존 검증 5개 추가 재실행 통과, Ruff·OpenAPI 일치 검사 통과. 로컬 `mori-backend:screen-api-0.6.0` 이미지 빌드 후 테스트 DB에 0005를 적용하고 `/health/live`, `/health/ready`의 200 응답과 인증 없는 사용자 API의 401 응답을 확인했다. 이 이미지는 로컬 검증용이며 Harbor push나 운영 배포는 수행하지 않았다.


## 마이 탭 범위 정리 — 2026-09-30

마이는 로그인·로그아웃·사용자 정보·이름 수정·테마·요금제/결제 관리만 제공한다.
`GET/PUT /v1/me/preferences`와 `GET /v1/me/summary`는 제거했다. 대시보드 기록 수,
출근 시간, 카드 표시 간격, 최근 대화 토글, PoC 시간/등급 전환은 마이의 설정이 아니다.
기존 `user_preferences`의 비서 문맥은 보존하며 해당 테이블을 계정 설정 API에서 노출하지 않는다.

- `GET /v1/me`는 이름·소셜 제공자·가입일·실제 tier/role·프로필 revision을 반환한다.
- `PATCH /v1/me`: `{"display_name":"동엽", "revision":1}`. 이름만 수정할 수 있고 소셜 계정·등급·역할은 변경할 수 없다. 수정한 이름은 다음 소셜 로그인에서도 보존된다.
- `GET /v1/me/settings`: `{"theme":"system", "revision":0}` (최초 값).
- `PUT /v1/me/settings`: `{"theme":"dark", "revision":0}`. system/light/dark만 허용하며 충돌은 409다. 로그인 전 테마는 기기에 저장하고, 로그인 후에는 계정 설정을 적용한다.
- `GET /v1/plans`는 비로그인 상태에서도 조회한다. Free는 0원이고 별도 결제가 없다. Pro 가격·주기는 null이며 checkout_available=false다.
- `GET /v1/me/subscription`는 현재 권한과 결제 상태를 구분한다. 관리자 승인 Pro는 access_source=admin_approval, billing_status=not_subscribed다. 결제 취소나 무료 선택으로 승인 권한을 임의로 회수하지 않는다.
- 결제사·가격·주기 미정으로 실제 결제/취소 endpoint와 webhook은 아직 제공하지 않는다. 결제 완료나 해지 완료를 흉내 내거나 tier를 클라이언트에서 전환하지 않는다.
- 로그인/로그아웃은 기존 네이버·카카오 흐름과 `POST /v1/auth/logout`을 사용한다.

0006은 계정 테마 테이블과 프로필 revision만 추가한다. 0005까지의 사용자·기록·기능 데이터와
내부 비서 문맥을 변경하지 않는다. 검증: PostgreSQL 테스트 185개, PoC 테스트 51개 통과.
