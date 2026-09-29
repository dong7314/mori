# 2026-09-29 — 채팅 API 통합과 주차 작업 구현 현황

[전체 계획](../plan.md) · [백엔드 계획](plan.md) · [런타임 현장 상태](../architecture/hermes-knative-validation-2026-09-29.md)

## 1. 코드 기준과 완료의 의미

- `master` `478bf54`: 사용자별 대화·SSE·주차 작업, 검색 API/임시 토큰 제거, 통합 테스트.
- `master` `7ab5229`: 채팅 계약, 터미널 클라이언트, Compose/k3s 설정, 이전 검색 문서 정리.
- API 버전 `0.5.0`, DB migration `0004_chat`.
- 위 코드는 Git에 커밋·push했다. 새 Mori API 이미지를 Harbor에 등록하거나 k3s에 배포한 것은 아니다.
- 기존 Hermes 이미지의 Responses SSE를 이용하므로 이번 채팅 기능 때문에 Hermes 이미지를 다시 빌드할 필요는 없다.
- 제품 React/앱 또는 `poc` 화면에는 이번 기능을 연결하지 않았다.

실제 코드와 프론트 계약은 [master 채팅 문서](https://github.com/dong7314/mori/blob/7ab5229/backend/docs/chat.md),
[OpenAPI](https://github.com/dong7314/mori/blob/7ab5229/backend/docs/openapi.json)를 기준으로 한다.

## 2. 확정한 API 방향

사용자는 일반 대화·검색·주차를 각각의 AI API로 나누지 않고 채팅으로 요청한다.
프론트는 검색 여부를 판정하지 않는다. Hermes가 필요에 따라 웹 검색·본문 추출·이미지 도구를 선택한다.

```text
프론트/터미널 → 인증된 채팅 API → 서버에서 Hermes 연결 선택
                              → Hermes 요청 해석·도구 실행
                              → Mori가 주차 작업 제안 검증·DB 처리
                              → SSE 진행 상태 + 최종 답변
```

`POST /v1/assistant/search`는 제거했다. 이 경로는 새 코드에서 404이며 OpenAPI에도 없다.
검색 전용 `mori_lab_` 인증 우회, 생성/검사 스크립트, 환경 설정과 k3s 패치도 제거했다.
기존 9월 28일 검색 API 기록은 과거 구현 이력으로만 보존한다.
Hermes/SearXNG 자체 smoke 스크립트와 검색 기능은 유지한다.

주차의 구조화된 저장·최신 조회 API는 유지한다. 대시보드에서 DB 기록을 표시하거나 직접 입력할 때
LLM을 호출할 필요가 없기 때문이다. 에이전트 연결 선택은 별도 공개 API가 아니라 서버 내부 처리다.

## 3. 기능별 현재 상태

| 기능 | 코드에 구현된 내용 | 미완료/검증 경계 |
| --- | --- | --- |
| 소셜 가입·로그인 | 네이버·카카오, 일회용 코드 교환, 토큰 갱신·세션 로그아웃, 내 정보 | 실제 공급자·제품 앱 인수 검증 별도 |
| Free/Pro | 최고 관리자 승인·회수, 가입자 목록, 권한 변경 이력 | 결제·구독·자동 Pod 생성 없음 |
| 주차 데이터 | 인증 사용자별 저장·최신 조회·멱등성 | 수정·삭제·패턴 학습·위젯 미구현 |
| 대화 | 생성·목록, 메시지와 최종 답변, 실행 이벤트·상태 저장 | 그룹·폴더·제목 변경·삭제·전체 기록 페이지네이션 미구현 |
| 자연어 주차 | Hermes JSON 제안 검증 후 Mori DB 저장/조회 | 실제 모델의 해석 정확성·k3s 왕복은 배포 후 검증 |
| 일반 대화·검색 | 같은 메시지 API; Hermes가 검색 판단, 실제 도구 호출 상태 전달 | 사실 정확성·출처의 완전성·이미지 실제 로딩 보증 아님 |
| 진행 상태 | 접수·연결·도구·DB 작업·최종 답변·완료/실패/중단 SSE | 내부 추론 노출 없음, 답변 토큰 단위 전송 없음 |
| 실행 기록 | 같은 요청 키로 종료 기록 재생, 중복 저장 방지, 상태 조회 | 영속 백그라운드 작업 큐/자동 재시도 아님 |
| runtime 선택 | 공용 테스트 소유자 또는 미리 배정한 Pro 개인 URL/키 | 개인 Knative Service/PVC/키 자동 생성·회수 없음 |
| cold start 연계 | Knative Route 호출, 초기 응답 90초/전체 300초 기본 제한 | 사전 깨우기·예약 실행 lease·완료 callback 없음 |
| 예약·캘린더 | 이번 구현 없음; 예약 요청에는 미지원 표시 | “내일 8시 반 알림”을 실제 등록하지 않음 |
| 문서·음성 | 기존 이미지의 문서 도구 준비와 제품 API는 별개 | 업로드/다운로드·파일 소유권·STT/TTS 미구현 |

## 4. 현재 공개 채팅 계약

모든 경로에 소셜 로그인으로 발급된 Mori access token을 사용한다.

| 메서드/경로 | 동작 |
| --- | --- |
| `POST /v1/conversations` | 대화 생성; 제목 생략 가능 |
| `GET /v1/conversations` | 본인 대화 목록; 기본 50, 최대 100 |
| `POST /v1/conversations/{id}/messages` | `{message}` 입력, UUID `Idempotency-Key` 필수, SSE 응답 |
| `GET /v1/conversations/{id}/messages` | 최근 사용자 메시지·최종 답변·상태; 기본 50, 최대 100 |
| `GET /v1/conversations/{id}/runs/{run_id}` | 본인 실행 상태·답변·이벤트 조회 |

대화 소유권은 서버가 검사하며 남의 대화 UUID로 요청하면 404다. 모델이나 프론트가 user_id,
Hermes URL, 시스템 프롬프트를 요청 본문으로 덮어쓸 수 없다. 최근 완료된 최대 10턴/32,000자만
Hermes에 전달하며 다른 대화나 실패한 턴을 이력으로 넣지 않는다.

실제 DB 테이블은 `conversations`, `chat_turns`다. 장기 설계의 `AgentRun`, `AgentRuntime`,
outbox, `WakeSchedule`이 모두 구현된 것으로 해석하지 않는다.

## 5. 진행 상태와 주차 저장의 책임

Hermes SSE의 실제 function call 시작과 결과 수신을 읽어 Mori가 고정된 사용자용 문구로 변환한다.
추론 원문, 중간 JSON, commentary, 도구 인자/원문 결과, 인증키는 공개 이벤트에 전달하지 않는다.

| 이벤트 | 의미 |
| --- | --- |
| `run.accepted` | 요청 기록 생성 |
| `runtime.connecting` | Hermes 연결 시도; 실제 Pod 상태를 조회했다는 뜻은 아님 |
| `runtime.ready` | 런타임 도구 준비 검사 통과, 모델 처리 대기 |
| `tool.started` / `tool.returned` | 실제 도구 호출 시작/결과 도착. returned는 성공 보증 아님 |
| `action.started` / `action.completed` | Mori 주차 DB 처리 시작/커밋된 결과 |
| `capability.unavailable` | 예약 알림 등 미지원 안내 |
| `message.completed` | 완성된 최종 답변 |
| `run.completed`, `run.failed`, `run.interrupted` | 작업 종료 상태 |

주차는 이번에 새 Hermes 스킬/네이티브 도구를 등록한 방식이 아니다. Hermes가 `parking_save`,
`parking_lookup`, `reply` 중 하나를 제안하고 Mori가 실행한다. 실제 확인 없이 “주차 스킬을 찾았어요”
같은 문구를 생성하지 않는다. 주차 저장과 최종 답변·성공 이벤트를 같은 트랜잭션으로 커밋한다.

“지하 3층 B16에 주차했어. 내일 알려줘”의 현재 처리: 위치를 저장하고 예약 알림은 지원하지 않아
예약하지 않았다고 안내한다. 평소 출근 시각을 추정해 알림 등록을 완료했다고 답하지 않는다.

## 6. 재전송·중단·권한 경계

- 같은 대화/요청 키/내용의 종료된 작업은 저장 이벤트를 재생하고 Hermes나 DB 작업을 다시 실행하지 않는다.
- 같은 키의 다른 내용 또는 같은 대화의 동시 실행은 409다. 실패 작업을 새 키로 무조건 자동 재시도하지 않는다.
- SSE 200 이후 오류는 `run.failed` 이벤트로 전달된다. HTTP 200만 보고 완료 처리하지 않는다.
- 연결이 끊기면 upstream 연결을 닫고 중단 상태를 기록한다. 이미 커밋된 DB 작업은 완료 상태로 보존한다.
- API 프로세스 종료 시 남은 running 기록은 전체 제한 + 30초가 지난 후 조회/다음 요청 때 만료 처리한다.
- 영속 큐가 없으므로 앱을 닫아도 반드시 끝까지 실행되는 장기 작업을 제공하는 단계는 아니다.
- 공용 home은 계정별 격리가 완성되지 않아 지정 테스트 소유자 1명만 허용한다.
- 서버 설정의 사용자 UUID → 개인 URL/키 바인딩은 Pro만 허용한다. 사전 생성된 개인 runtime이 필요하다.
- 현재 도구 허용 범위는 web/mori_images다. 문서/터미널 toolset 활성화 시 채팅 준비 검사에서 거부된다.

## 7. 검증 결과

최종 코드 기준 **139개 테스트 통과**. PostgreSQL은 별도 일회용 컨테이너에서 실행하고 검증 후 제거했다.
기존 173개에서 숫자가 줄어든 것은 제거된 독립 검색 API/토큰 테스트를 정리하고 채팅 프로토콜
검사로 옮겼기 때문이다. 해당 수치를 실환경 동작 성공 건수로 해석하지 않는다.

- 실제 PostgreSQL migration, 로그인/권한/주차 회귀, 대화 소유권 및 Pro 라우팅.
- 같은 키 재전송·동시 실행 거부·실패 롤백·만료·연결 종료 전후의 커밋 보존.
- 모의 Hermes HTTP/SSE로 검색 없는 일반 답변과 검색 도구가 포함된 답변 검증.
- 추론/원문 비노출, 잘못된/끊긴 응답·unsafe tool·timeout 처리, 검색 경로 404.
- Ruff lint/format, OpenAPI 일치, Compose config, `git diff --check` 통과.
- `0004_chat` migration과 ORM 일치 검사도 채팅 구현 과정에서 확인했다.

실제 네이버/카카오 로그인→새 Mori 채팅 API→Knative→GPU→주차 DB→SSE 왕복은 아직 미검증이다.

## 8. 다음 실행 순서

1. `master`를 받아 새 Mori API 이미지를 빌드·Harbor 등록한다. 기존 Hermes 이미지는 유지한다.
2. 서버 Secret에 DB·소셜 인증·Hermes 키·테스트 소유자 UUID를 준비한다. Git에 비밀 값을 넣지 않는다.
3. 새 API 이미지의 migration Job(`mori-migrate-0004`) 성공 후 API를 배포한다.
4. `MORI_CHAT_ENABLED=true`, 내부 Knative Route, startup 90초/전체 300초를 설정한다.
5. 소셜 로그인 access token으로 `backend/scripts/test_chat.py` 실행: 일반 대화 → 주차 저장 → 같은 대화 조회 → 검색 요청.
6. Pod가 0개일 때도 같은 채팅 요청으로 기동·SSE·최종 결과를 확인한다. 저장 재전송·연결 종료 후 조회도 확인한다.
7. 프론트는 fetch POST 스트림으로 SSE를 읽고 실제 이벤트만 스피너로 표시한다. 아직 PoC에는 연결하지 않았다.
8. 이후 Pro runtime 자동 배정·공용 사용자 격리, 예약 사전 기동/실행 유지/결과 반영 계약을 개발한다.
