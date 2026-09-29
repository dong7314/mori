# Mori 검색 API와 임시 인증 — 로컬 구현 기록

> **이력 문서:** 아래는 당시 상태다. 2026-09-29 현재 완료 범위와 다음 실행은 [최신 기록](chat-implementation-2026-09-29.md)을 따른다. 검색 API/임시 토큰은 제거됐고 런타임은 재배포·Knative 기동/종료 검증을 마쳤다.

[전체 계획](../plan.md) · [백엔드 계획](plan.md) · [실제 Hermes 검증](../architecture/hermes-web-validation-2026-09-28.md) · [이미지·YAML 전환](../architecture/runtime-image-transition.md)

갱신일: 2026-09-28. **구현과 로컬 검증까지 진행했으며 실제 Mori API의 k3s 배포·통합 요청은 아직 하지 않았다.** 검색 API·임시 인증의 코드 기준은 `master` `7a19b61`이다. 이어서 `2e2a397`에 이미지·YAML·검사 CLI, `8fe2f85`에 배포 안내를 커밋했다. 실습 Hermes/SearXNG가 삭제됐으므로 통합 시험 전에 새 이미지를 worker에 재배포해야 한다. Git 코드 저장과 Harbor 등록·실서비스 배포를 구분한다.

## 1. 구현하게 된 이유와 범위 변경

1. 공용 Hermes의 검색·이미지·본문 추출은 직접 검사로 통과했다.
2. 사용자가 `mori` namespace에 Hermes만 있으며 Mori API는 미배포라고 확인했다.
3. 제품 API 경유 통합을 위해 `POST /v1/assistant/search`를 구현했다.
4. 사용자는 로그인 페이지 추가를 원하지 않았고, master에서 Python으로 검사할 수 있는 임시 토큰 방식을 요청했다.
5. 임시 브라우저 로그인/검색 보조 페이지는 제거했다. 현재 추가된 기능에 새 프론트 페이지는 없다.
6. 이후 사용자는 통합 시험을 위한 배포 준비를 반복하기보다 실제 기능 개발과 정식 이미지·YAML 관리를 우선하기로 했다. 임시 토큰 통합 시험은 구현은 보존하되 아직 실행 완료로 처리하지 않는다.

## 2. 요청·응답 계약

```http
POST /v1/assistant/search
Authorization: Bearer <Mori access token 또는 활성화한 임시 검색 토큰>
Content-Type: application/json
```

```json
{
  "message": "국립중앙박물관 공식 관람 안내를 검색하고 본문을 읽어서 관람시간과 입장 마감을 출처와 함께 알려줘."
}
```

| 항목 | 현재 구현 |
| --- | --- |
| 입력 | `message`만 허용, 입력 길이 1~4,000자, trim 후 빈 값 거부, 줄바꿈/탭 외 ASCII 제어 문자·알 수 없는 필드 거부 |
| 실행 | Hermes `/v1/toolsets` 설정 확인 후 `/v1/responses` 요청 |
| 답변 | `request_id`, `answer`, `sources`, `tools` |
| 출처 | 도구에서 실제 반환한 URL·제목, `evidence=search` 또는 `extract` |
| 도구 상태 | 이름·성공/실패·유효 결과 수 |
| 제한 | 출처 최대 30개, 답변 최대 32,000자, 상류 HTTP 본문 크기 제한 |
| 응답 방식 | 단일 비스트리밍 요청, 기본 전체 timeout 300초(설정 범위 10~600초) |

예시 응답은 계약 설명용이며 실제 k3s 실행 결과가 아니다.

```json
{
  "request_id": "f7dbd2a1-b551-4c1a-8cf4-77d92b9d8727",
  "answer": "공식 관람 안내를 확인한 결과 …",
  "sources": [
    {
      "title": "관람 안내",
      "url": "https://www.museum.go.kr/MUSEUM/contents/M0101000000.do",
      "evidence": "extract"
    }
  ],
  "tools": [
    {"name": "web_search", "status": "succeeded", "result_count": 5},
    {"name": "web_extract", "status": "succeeded", "result_count": 1}
  ]
}
```

실제 성공한 비어 있지 않은 `web_search` 결과가 있어야 성공 응답을 반환한다. 최종 답변 문장만으로 “검색했다”고 판정하지 않는다. `sources`는 도구가 반환한 후보/추출 출처이며 모든 문장을 사실 검증했다는 뜻이 아니다. 검색은 성공했지만 일부 추출이 실패한 경우 도구별 실패 상태를 남기고 검색 결과로 답변할 수 있다.

## 3. Hermes 호출과 사용자 경계

- 소셜 인증 경로는 실제 Mori 세션을 검증하고 `MORI_HERMES_TEST_USER_ID`에 지정한 운영자 한 명만 허용한다. Free/Pro 전체 공개 경로가 아니다.
- 임시 인증 경로는 아래 별도 조건으로 검색 요청만 허용한다. 사용자 ID를 임의 생성하거나 가입시켜 주지 않는다.
- 클라이언트가 모델, Hermes URL, instructions, 사용자 ID, session key, previous response ID를 지정하지 못한다.
- 요청은 `store: false`, `stream: false`이며 기존 세션 헤더나 응답 ID를 이어 보내지 않는다. **Hermes 자체 SQLite·로그·profile 기억이 전혀 저장되지 않는다는 보장은 아니다.**
- Mori 사용자 Bearer를 Hermes에 전달하지 않는다. 서버가 보유한 Hermes `API_SERVER_KEY`로 상류 요청을 인증한다. llama.cpp 키와도 별개다.
- 모델 추론을 기다리기 전에 Mori 인증 DB 트랜잭션을 종료해 연결을 반환한다.
- 요청 전 도구 세트를 검사하며 허용 범위는 `web` 및 필요한 `mori_images`다. 설정 조회와 실행 사이의 변경이나 자동 MCP의 모든 경로를 통제하는 sandbox는 아니다. 테스트 계정과 Hermes 자체 설정 제한을 함께 유지한다.
- 직접 도구 호출과 `tool_call` 간접 호출, 외부 데이터 태그를 해석하고 `call_id`로 결과를 연결한다. 추론 내용·상류 원시 세션·원문 도구 전체를 클라이언트에 노출하지 않는다.

현재 공용 profile은 다중 사용자 보안 경계가 아니다. 이전 운영자의 home에 새 운영자 ID를 지정한다고 기억·파일이 자동 분리되지 않는다. 제품 공개 전 사용자별 기록/도구/파일 격리는 별도 구현해야 한다.

## 4. 임시 검색 토큰

| 설정 | 의미 |
| --- | --- |
| `MORI_ASSISTANT_TEST_TOKEN_ENABLED` | 기본 `false`, 명시적 활성화 필요 |
| `MORI_ASSISTANT_TEST_TOKEN` | 생성한 검색 시험 전용 비밀 값 |
| `MORI_HERMES_BASE_URL` | 클러스터 내부 기준 `http://mori-hermes-shared.mori.svc.cluster.local:8642` |
| `MORI_HERMES_API_KEY` | 기존 `mori-hermes` Secret의 `API_SERVER_KEY` 참조 |
| `MORI_HERMES_TIMEOUT_SECONDS` | 기본 300 |

토큰은 `mori_lab_` 접두사와 난수 64자로 구성되며 384비트 난수를 사용한다. 생성기는 파일을 권한 `0600`으로 새로 만들고 기존 파일을 덮어쓰지 않으며 값을 출력하지 않는다. 서버 비교에는 상수 시간 비교를 사용한다.

활성화된 정확한 토큰을 받으면 **`POST /v1/assistant/search`에서만** 소셜 로그인·DB 세션 검증을 생략한다. 네이버/카카오 앱 키, 가입된 사용자 UUID는 이 경로에 필요 없다. `/v1/me`, 주차, 관리자 API의 인증을 우회하지 않는다. 사용자·세션·Pro 권한도 생성하거나 변경하지 않는다. 정식 가입은 계속 네이버·카카오로만 가능하다.

임시 인증 자체는 DB를 조회하지 않지만 API의 readiness는 DB와 스키마를 확인한다. 따라서 정상적인 Service 배포에는 PostgreSQL과 기존 마이그레이션이 필요하다. 클러스터에 PostgreSQL이 있다는 사실과 Mori DB 연결/스키마 준비 완료는 구분한다.

### 준비한 CLI 파일 — 실행 완료 아님

제품 `master`의 저장소 상대 경로:

```text
backend/scripts/create_assistant_test_token.py
backend/scripts/test_assistant_search.py
backend/docs/assistant-search.md
backend/docs/assistant-test-token.md
infra/k3s/backend-hermes-search.patch.yaml
infra/k3s/backend-hermes-test-token.patch.yaml
```

`create_assistant_test_token.py --output <파일>`로 생성하고 테스트용 Secret으로 연결한다. API가 준비된 후 `test_assistant_search.py --test-token-file <파일>`로 무인증 401·잘못된 토큰 401·정상 검색을 확인하는 절차를 마련했다. 종료 시 모드를 비활성화하고 rollout 후 `--check-disabled`로 기존 토큰이 401인지 검사한다. 그 후 시험 전용 Secret/파일을 제거한다.

이 절차는 로그인 페이지·도메인·공개 Ingress 없이 내부 Service와 루프백 port-forward로 실행할 수 있다. **현재 토큰 Secret 생성, API 패치 적용, 실환경 PASS, 종료/삭제가 실행됐다는 로그는 없다.**

## 5. 오류와 실행 한계

| HTTP | 의미 |
| --- | --- |
| 401 | 인증 없음·잘못된/비활성 임시 토큰·유효하지 않은 Mori 세션 |
| 403 | 소셜 인증은 유효하지만 지정 테스트 계정 아님 |
| 422 | 메시지/추가 필드 등 입력 오류 |
| 502 | 상류 응답 형식·인증/경로 오류, 실제 검색 성공 증거 부족 |
| 503 | Hermes 미설정·도구 준비 불충분·연결/과부하 오류 |
| 504 | 전체 대기 기한 초과 |

상류 오류의 비밀 값과 원문을 그대로 반환하지 않는다. 자동 재시도는 하지 않는다. HTTP timeout이나 클라이언트 종료가 이미 시작된 Hermes 작업의 취소를 뜻하지 않으므로 즉시 재전송해 중복 실행시키지 않도록 한다. 영속 큐, 취소, 재개, 서버 간 중복 실행 방지는 이번 검색 API에 포함하지 않았다.

## 6. 변경 파일과 검증 범위

| 영역 | 파일/변경 |
| --- | --- |
| 검색 구현 | `backend/src/mori/assistant/{auth,evidence,hermes,router,schemas}.py` |
| 앱 설정 | `backend/src/mori/config.py`, `main.py`, 환경 변수 예시 |
| 계약/의존성 | OpenAPI, 프로젝트 버전 0.4.0, `pyproject.toml`, `uv.lock` |
| 실행 보조 | CLI 두 개, k3s 패치 두 개, Compose 설정 |
| 테스트 | `test_assistant.py`, `test_assistant_token_script.py` |
| 문서 | 검색 계약·임시 토큰·README/배포 안내 |

9월 28일 커밋 전 다시 확인한 로컬 검증 결과는 전체 **157 tests passed**, 의존성 deprecation 경고 2개, Ruff lint/format·OpenAPI 동기화·diff 검사 통과다. 실제 PostgreSQL을 사용한 인증/DB 테스트와 **Hermes HTTP를 MockTransport로 대체한 검사**를 포함한다. 임시 인증이 DB 접근 없이 상류 모의 응답까지 도달하는 검사도 있다. 커밋 전 전체 테스트·Ruff·OpenAPI 동기화를 다시 실행해 같은 결과를 확인했다.

로컬 `mori-backend:hermes-search-check` Docker 이미지 빌드는 통과했지만 개발 PC의 native ARM 빌드다. Harbor push, k3s worker용 amd64 빌드·실행, 실제 Hermes 연동을 증명하지 않는다. 검색 기능 자체는 신규 DB 테이블/마이그레이션을 추가하지 않았다.

## 7. 지금 구현되지 않은 제품 기능

- 일반 대화 API·대화 이력/그룹, 이전 요청의 맥락 이어받기.
- 자연어 → Hermes의 주차 도구 → 사용자별 Mori DB 저장/조회. 기존 구조화된 주차 API는 있지만 에이전트 도구 연결은 아직 없다.
- 검색/도구 이력의 사용자별 영속 저장, 다중 사용자 공용 runtime 격리.
- 일정 등록, 예약 실행·중복 방지·알림·OS 위젯.
- 실제 여행 경로 계산, PDF/Excel 파일 생성·보관·전달.
- Pro 전용 Pod, 실제 Hermes scale-to-zero, 복원·부하 검증.

다음 제품 인수 시나리오는 “지하 2층 C구역 C36에 주차했어”를 받은 뒤 모델의 응답뿐 아니라 **Mori DB 저장과 이후 조회**까지 확인하는 것이다. 실습 코드의 이미지·YAML 편입과 로컬 기동 검증은 완료했고, Harbor 등록·새 PVC 재배포·실환경 회귀가 남아 있다. 도메인 발급과 공개 배포를 로컬 기능 개발의 선행 조건으로 삼지 않는다.
