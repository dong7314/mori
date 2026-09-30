# 채팅과 실제 작업 진행 상태 (Mori API 0.5.0)

## 구현 범위

로그인한 사용자별 대화·메시지·실행 기록을 PostgreSQL에 저장한다. Hermes Responses SSE를
읽어 실제 도구 시작/결과 수신 이벤트를 전달하고, 최종 JSON 작업 제안을 검증한 뒤 Mori가
주차 저장·조회를 실행한다. 일반 답변과 검색도 같은 대화에서 가능하다. 프론트는 검색 여부를 선택하지 않으며 Hermes가 필요에 따라 검색한다.

**화면에 보이는 것은 내부 추론 원문이 아니라 실행 상태다.** reasoning, 중간 commentary,
모델의 JSON 토큰, 도구 인자/원문 결과, Hermes 인증키는 공개 이벤트에 넣지 않는다.
프론트엔드는 이벤트를 스피너/상태 문구로 표시하고 최종 답변을 채팅 말풍선으로 표시한다.
현재 최종 답변은 완성된 문장으로 한 번 전달한다. 토큰 단위 답변 스트리밍은 제공하지 않는다.

주차는 새 Hermes 스킬을 설치한 방식이 아니다. Hermes가 `parking_save`, `parking_lookup`,
`reply` 중 하나를 제안하는 **Mori 작업 어댑터**다. 저장 성공 문구는 모델이 아니라 DB 결과에서
생성한다. 따라서 실제 조회하지 않은 “주차 스킬을 발견했어요” 같은 이벤트는 만들지 않는다.

예약 알림/시간대 대시보드/개인 Pod 자동 생성은 아직 구현하지 않았다. “내일 알려줘”를 해석하면
주차 저장은 수행하되 예약은 미지원이라고 명시한다. 일반 대화의 사실 정확성 및 자연어 의도
해석 정확성은 별도 실모델 검증 대상이다. 이 API는 문서 생성/임의 터미널 실행용이 아니다.

## 요청 흐름

1. Mori 인증·대화 소유권 검사 → 서버 설정으로 런타임 선택.
2. 실행 ID를 저장하고 `run.accepted`, `runtime.connecting` 전송.
3. Knative Route의 `/v1/toolsets` 호출. Pod가 0개이면 이 요청으로 기동된다.
   최초 응답 대기는 기본 90초, 전체 작업 제한은 기본 300초다.
4. 허용된 검색·이미지 도구 구성인지 검사한 뒤 `/v1/responses`에 `stream:true`, `store:false`,
   해당 대화의 완료된 최근 기록을 전달한다. 최대 10턴/32,000자이며 원시 도구 기록은 제외한다.
5. Hermes의 실제 function call 시작/결과 수신을 공개 이벤트로 변환한다.
6. 최종 JSON을 검증한다. 주차 작업은 클라이언트/모델의 사용자 ID를 받지 않고 인증 사용자로 실행한다.
7. 주차 DB 변경과 최종 답변·성공 이벤트를 같은 트랜잭션으로 커밋한 후 전송한다.

`tool.returned`는 결과가 도착했다는 뜻이며 검색 성공을 보증하지 않는다. 검색 사실/이미지 로딩의
검증은 기존 검색 smoke와 별도 검토를 사용한다. 도구 구성 검사는 샌드박스가 아니므로 런타임의
실제 도구 제한도 유지해야 한다. 현재 `tool_call` 간접 호출은 단일 호출만 지원한다.

## 서버 설정 및 배포

먼저 새 Mori API 코드로 이미지를 빌드하고 DB migration을 적용한다. Hermes 0.1.1 이미지의
기존 Responses SSE를 이용하므로 이번 기능 때문에 Hermes 이미지를 다시 만들 필요는 없다.

```sh
# backend 디렉터리, 서버의 MORI_DATABASE_URL 설정 후
uv run alembic upgrade head
```

추가 migration은 `0004_chat`이다. migration 적용 전에는 새 API readiness가 실패한다.

```dotenv
MORI_CHAT_ENABLED=true
MORI_HERMES_BASE_URL=http://mori-hermes-knative.mori.svc.cluster.local
MORI_HERMES_API_KEY=<서버 Secret의 API_SERVER_KEY>
MORI_HERMES_TEST_USER_ID=<로그인한 테스트 소유자의 UUID>
MORI_HERMES_STARTUP_TIMEOUT_SECONDS=90
MORI_HERMES_TIMEOUT_SECONDS=300
MORI_CHAT_PRIVATE_RUNTIMES={}
```

Git에는 키를 넣지 않는다. `infra/k3s/backend-chat.patch.yaml`은 API가 이미 배포된 경우에 쓰는
선택적 strategic merge patch다. 소유자 UUID를 서버에서 치환하고 적용한다. 실제 배포 이미지와
DB migration은 별도 진행해야 한다. 브라우저 앞 프록시는 SSE 버퍼링을 끄고 응답 제한을 작업
시간보다 길게 설정한다. 10초 heartbeat는 연결 유지용이며 진행률이 아니다.

공용 Hermes home은 아직 다중 사용자 격리가 검증되지 않았으므로 `MORI_HERMES_TEST_USER_ID`
한 명에게만 연결한다. 대화 DB 격리만으로 공용 agent 메모리/파일 격리가 완성되지는 않는다.
Pro 개인 런타임을 미리 만들어 둔 경우에만 서버 Secret으로 다음 형식의 라우팅을 설정할 수 있다.

```json
{"사용자-UUID":{"base_url":"http://개인-knative-route","api_key":"개인-키"}}
```

사용자마다 별도 Knative Service/home/PVC/키가 필요하다. free 사용자에 개인 바인딩이 있으면
403이며 임의로 공용 런타임에 폴백하지 않는다. Pro 승인 자체가 Pod를 생성하지는 않는다.
별도 검색 API와 로그인 우회용 임시 검색 토큰은 제거했다. 채팅/DB 저장에는
네이버·카카오 로그인으로 발급받은 Mori access token이 필요하다.

## API와 프론트 계약

모든 요청에 `Authorization: Bearer <Mori access token>`을 사용한다.

| 요청 | 용도 |
|---|---|
| `POST /v1/conversations` `{ "title": "출근과 주차" }` | 대화 생성 (201) |
| `GET /v1/conversations?limit=50` | 본인 대화 목록, 생성 시각 내림차순 |
| `POST /v1/conversations/{id}/messages` `{ "message": "지하 3층 B16에 주차했어. 내일 알려줘" }` | SSE 작업 실행 |
| `GET /v1/conversations/{id}/messages?limit=50` | 최근 메시지·최종 답변·상태, 시간 오름차순 |
| `GET /v1/conversations/{id}/runs/{run_id}` | 연결 종료 후 실행 상태·저장된 이벤트 조회 |

메시지 POST는 UUID 형식 `Idempotency-Key` 헤더가 필수다. 동일 키/동일 내용의 종료된 요청은
저장 이벤트만 재생한다. 실행 중 재요청 또는 같은 대화의 동시 요청은 409, 같은 키/다른 내용도
409다. 새 사용자 요청에만 새 키를 발급한다. 실패 후 무조건 새 키로 자동 재시도하지 않는다.

HTTP 200 이후 발생한 오류는 HTTP 상태 대신 `run.failed` SSE로 전달된다. 200을 성공 완료로
취급하지 않는다. 헤더 `X-Mori-Run-ID` 또는 첫 이벤트의 `run_id`를 보관한다. SSE `id`는
`<run UUID>:<순번>`이며 UI는 이 값으로 중복 이벤트를 제거한다. `Last-Event-ID` 자동 이어받기는
미지원이다. 연결이 끊기면 실행 조회 API로 확인하고 필요할 때 동일 키 POST로 기록을 재생한다.

| 이벤트 | UI 표시 |
|---|---|
| `run.accepted` | 사용자 말풍선 아래 대기 표시 |
| `runtime.connecting` | “모리에게 연결하고 있어요” 스피너; 실제 Pod 상태로 단정하지 않음 |
| `runtime.ready` | “모리가 요청을 확인하고 있어요” |
| `tool.started` | 웹 검색/본문 확인 등 실제 호출 상태; `call_id`로 구분 |
| `tool.returned` | 해당 도구 결과 수신 표시; 성공 체크로 단정하지 않음 |
| `action.started` | “주차 위치를 저장하고 있어요” 또는 조회 중 |
| `action.completed` | DB 처리 결과. `result`는 주차 레코드 또는 조회 결과 없음(null) |
| `capability.unavailable` | 예약 알림 등 미지원 기능 안내 |
| `message.completed` | `text`를 최종 답변 말풍선에 표시 |
| `run.completed` | 스피너 종료 |
| `run.failed` / `run.interrupted` | 스피너 종료, 결과 확인 안내 |

예시 프레임:

```text
id: <run-uuid>:4
event: action.started
data: {"id":4,"run_id":"<run-uuid>","type":"action.started","action":"parking_save","message":"주차 위치를 저장하고 있어요."}

```

브라우저 기본 `EventSource`는 이 POST/인증 헤더 방식에 맞지 않으므로 `fetch()`의
`response.body` 스트림과 SSE 파서를 사용한다. 네트워크 청크와 SSE 프레임 경계는 다르므로
청크마다 JSON.parse하지 말고 빈 줄까지 누적한다. 텍스트는 HTML 삽입 없이 표시하고 Markdown을
사용한다면 sanitize한다. 아래 실행 가능한 Python 클라이언트가 프레임 처리의 참고 예제다.

```sh
# backend 디렉터리. 프론트 없이도 가능하며 토큰은 숨김 입력한다.
uv run python scripts/test_chat.py --base-url http://127.0.0.1:8000 \
  --message '지하 3층 B16에 주차했어. 내일 알려줘'
# 출력된 conversation ID로 이어서 조회
uv run python scripts/test_chat.py --base-url http://127.0.0.1:8000 \
  --conversation <conversation-uuid> --message '내 차 어디야?'
```

## 연결 종료와 검증 범위

현재는 요청 수명에 묶인 스트림이며 영속 작업 큐가 아니다. 연결 종료 시 upstream 스트림을
닫고 중단 상태를 기록한다. 이미 DB에 커밋된 주차 작업은 취소되지 않으며 완료 기록으로 확인한다.
프로세스가 갑자기 죽으면 전체 제한 + 30초 이후 조회/다음 요청 시 만료 처리한다. 웹 도구의
즉각적인 취소까지 보증하지 않는다. 이벤트 목록/완료 상태만 저장하며 숨겨진 추론은 저장하지 않는다.

자동 검증은 실제 PostgreSQL migration과 HTTP mock Hermes 스트림으로 사용자 격리, 중복
방지, 실패 롤백, 이벤트 필터링, 개인 런타임 권한, 연결 종료를 검사한다. 로컬 이미지 0.1.1의
SSE 구현과 이벤트 형식을 대조했다. 실제 k3s/GPU에서 자연어 저장→조회→cold start SSE까지는
서버 배포 후 위 클라이언트로 확인해야 한다.

## 0.6.0 화면 데이터와 기능 실행 확장

[현재 화면 API 계약](screen-api.md)이 이 문서의 주차 전용 action 범위를 확장한다.
채팅은 note_save/event_save/reminder_save/feature_save/feature_run도 검증한다.
메시지 body의 선택적 feature_id는 같은 사용자 소유의 활성 기능만 허용한다.
Hermes가 feature_run을 선택하면 서버가 정의 버전을 고정해 한 번 더 요청하며,
텍스트 결과를 FeatureResult로 저장한 후 result.saved를 보낸다. 메시지 기록에는
result_refs가 포함되어 상세 링크를 복원할 수 있다. OS 푸시·자동 예약 실행은 미연결이다.
