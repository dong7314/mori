# Hermes 검색 연동 API (단일 계정 실험)

`POST /v1/assistant/search`는 Mori 로그인 토큰 또는 명시적으로 활성화한 임시 검색 토큰을 검증한 뒤, 기존 공용 Hermes의 `/v1/responses`에 검색 요청을 보낸다. Hermes가 모델과 검색·본문 추출 도구를 실행한다. 클라이언트는 Hermes 키나 원시 도구 결과를 받지 않는다.

## 현재 범위

- 로그인 경로는 지정한 테스트 계정 **한 명**만 사용한다. 임시 토큰 경로는 계정 없이 검색만 테스트한다. 무료·프로 등급이나 관리자 역할을 바꾸지 않는다.
- 매번 독립적인 단일 요청이다. 대화 목록, 이전 응답 이어받기, 일정·주차 저장, 문서 생성은 포함하지 않는다.
- 사용자 입력은 `message`만 받는다. 사용자 ID, 모델, Hermes 주소, instructions, session key, previous_response_id는 클라이언트가 지정할 수 없다.
- `store: false`, `stream: false`로 호출하며 세션 헤더나 기존 대화 ID를 전달하지 않는다. 이는 응답 체인을 공유하지 않기 위한 설정이며 **Hermes의 세션 DB·로그·프로필 메모리까지 기록되지 않는다는 뜻은 아니다.**
- 공용 Hermes profile의 파일·메모리·스킬은 보안 격리 경계가 아니다. 테스트 계정은 해당 Hermes home에 접근해도 되는 운영자 본인으로 지정한다. 사용자 변경으로 기존 home이 정리되지 않는다. 사용자별 격리가 구현되기 전에는 다중 사용자에게 공개하지 않는다.
- 실제 검색 성공 결과가 있어야 HTTP 200이다. `sources`는 실제 도구가 반환한 후보 URL 목록이며, 답변의 모든 문장이 검증됐거나 모든 후보를 답변에서 인용했다는 뜻은 아니다. `evidence=extract`는 해당 URL의 비어 있지 않은 본문 반환을 관측했다는 뜻이다.

## 페이지 없이 master에서 테스트

소셜 로그인을 준비하지 않고 검사할 때는 [임시 토큰 생성·적용·검색·비활성화 절차](assistant-test-token.md)를 따른다. 기본은 비활성이며 `/v1/assistant/search`에만 적용한다. 이 경로에는 소셜 앱 키와 테스트 사용자 UUID가 필요 없다.

## 서버 설정 (소셜 로그인 경로)

기본값은 비활성이다. 소셜 로그인으로 검사할 때 기존 설정에 다음 값을 추가한다.

```dotenv
MORI_HERMES_BASE_URL=http://mori-hermes-shared.mori.svc.cluster.local:8642
MORI_HERMES_API_KEY=REPLACE_WITH_EXISTING_HERMES_API_SERVER_KEY
MORI_HERMES_TEST_USER_ID=REPLACE_WITH_AUTHENTICATED_MORI_USER_UUID
MORI_HERMES_TIMEOUT_SECONDS=300
```

- `BASE_URL`은 `/v1` 없는 origin이다. 클러스터 밖에서 실행하는 백엔드는 위 DNS를 사용할 수 없으므로 도달 가능한 내부 주소를 사용한다.
- `API_KEY`는 **Hermes의 `API_SERVER_KEY`**다. llama.cpp 키나 소셜 로그인 키가 아니다. Kubernetes에서는 아래 Secret 참조 방법을 사용하면 복사할 필요가 없다.
- `TEST_USER_ID`는 실제 소셜 로그인 후 `GET /v1/me`로 확인한 Mori UUID다. 네이버·카카오 ID가 아니다. 아직 가입하지 않았다면 우선 이 값을 비워 백엔드를 배포하고 로그인한 뒤 설정한다.
- 전체 대기 기한은 10~600초, 기본 300초다. Ingress와 프론트의 응답 대기 시간은 이보다 여유 있게 설정한다.

## Hermes 설정 확인

현재 실험의 고정 이미지 및 API 코드를 기준으로 구현했다.

```text
nousresearch/hermes-agent@sha256:d43ac4ef5c76ec063342cd1cb1c1f839ce73acffa9445bee87bbccfd39ccb808
upstream revision: 9a7b54accf841127bacfaab74fa1d7d982bca9fa
```

기존 Hermes의 `platform_toolsets.api_server`는 `web`, 필요한 경우 `mori_images`만 활성화한다. 기존에 검증한 SearXNG, `mori_extract`, `mori_images` 설정을 유지한다. terminal, 파일, 기억, 세션 조회, 스킬 실행, 기본 MCP 서버 등 다른 실행 경로는 이 검색 실험에 활성화하지 않는다.

API는 매 요청에 `/v1/toolsets`를 조회해 활성 도구 세트가 `web`/`mori_images` 범위인지, web_search/web_extract가 준비됐는지 확인한다. 단, 이 목록은 모든 자동 MCP 경로를 보장하지 않고 설정 확인과 실행도 원자적이지 않다. **설정 검사는 sandbox가 아니며 프롬프트나 요청 body의 `tools`만으로 권한이 제한된다고 가정하지 않는다.** 알려진 다른 도구 실행이 응답에 관측되면 결과를 거부하지만 이미 실행된 도구를 되돌릴 수는 없다. 따라서 테스트 계정 제한과 Hermes 측 설정을 함께 유지한다.

최초 `infra/k3s/hermes-shared.yaml` 초안은 제거했다. [Hermes·SearXNG 배포 가이드](../../infra/k3s/hermes-shared.md)의 Kustomize 구성을 사용한다.

## 요청과 응답

```http
POST /v1/assistant/search
Authorization: Bearer <Mori access_token>
Content-Type: application/json
```

```json
{
  "message": "국립중앙박물관 공식 관람 안내를 검색하고 본문을 읽어서 관람시간과 입장 마감을 출처와 함께 알려줘."
}
```

message는 공백 제거 후 1~4,000자이며 알 수 없는 필드는 거부한다. 성공 응답 예시:

```json
{
  "request_id": "f7dbd2a1-b551-4c1a-8cf4-77d92b9d8727",
  "answer": "공식 관람 안내에 따르면 … 출처: https://www.museum.go.kr/…",
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

직접 호출 및 단일 `tool_call` 간접 호출을 call_id로 연결한다. 외부 데이터 태그로 감싼 JSON도 해석한다. 출처 URL은 최대 30개, 답변은 최대 32,000자다. 도구 원문, 추론 내용, 상류 세션 ID는 응답에 포함하지 않는다. 프론트는 답변과 출처 제목을 외부 콘텐츠로 취급해 안전하게 렌더링한다.

검색 성공 후 일부 본문 추출만 실패하면 답변을 반환할 수 있다. `tools[].status=failed`를 표시하고 본문을 확인한 것처럼 안내하지 않는다. 답변 사실 정확성은 별도 검토 대상이다.

| HTTP | code | 의미 |
| --- | --- | --- |
| 401 | UNAUTHORIZED | Mori 인증 누락·만료·폐기 |
| 403 | ASSISTANT_TEST_ACCESS_REQUIRED | 지정 테스트 계정이 아님 |
| 422 | VALIDATION_ERROR | 메시지 또는 알 수 없는 필드 오류 |
| 503 | HERMES_NOT_CONFIGURED | 연결 설정 또는 테스트 계정 미설정 |
| 503 | HERMES_TOOL_POLICY_MISMATCH / HERMES_TOOLS_UNAVAILABLE | 도구 설정 확인 필요 |
| 503 | HERMES_UNAVAILABLE | 연결 실패 또는 상류 과부하/서버 오류 |
| 502 | HERMES_UPSTREAM_ERROR | 상류 인증·경로·리다이렉트 등 비정상 HTTP 응답 |
| 502 | HERMES_INVALID_RESPONSE | JSON·본문·실행 증거 형식 오류 |
| 502 | SEARCH_NOT_VERIFIED | 실제 성공한 웹 검색 결과가 없음 |
| 504 | HERMES_TIMEOUT | 전체 대기 기한 초과 |

상류 오류 원문·키·사용자 메시지는 오류 응답이나 애플리케이션 로그에 남기지 않는다. 인증 트랜잭션은 모델을 기다리기 전에 종료해 DB 연결을 반환한다. 자동 재시도는 하지 않는다. HTTP 대기 종료/클라이언트 연결 종료가 Hermes 작업의 취소를 보장하지 않는다. 곧바로 반복 요청하지 말고 Hermes 실행 상태를 확인한다. 이 버전은 영속 작업 큐·재개·취소·서버 간 중복 실행 방지를 구현하지 않았다.

## k3s 배포와 실제 테스트 (소셜 로그인 경로)

기존 [백엔드 배포 절차](../../infra/k3s/README.md)대로 PostgreSQL과 로그인 설정을 먼저 준비한다. 이번 기능은 새 테이블이 없어 새 마이그레이션이 필요하지 않지만, 신규 DB에는 기존 마이그레이션을 전부 적용해야 한다.

백엔드 이미지 빌드·Harbor 업로드 후 `backend.yaml`, `migrate.yaml`의 이미지 값을 같은 태그/digest로 맞춘다. Harbor 주소와 CPU 아키텍처는 실제 환경에 맞게 지정한다. 예시:

```sh
# 소스가 있는 빌드 머신에서 실행. amd64 worker 기준이며 Harbor 주소는 실제 값으로 지정.
MORI_IMAGE=YOUR_HARBOR_HOST/YOUR_PROJECT/mori-backend:0.4.0
# 먼저 실제 Harbor에 docker login을 완료한다.
docker buildx build --platform linux/amd64 -t "$MORI_IMAGE" --push backend
```

master의 배포 파일에서 `mori-api` 컨테이너 env에 다음 항목을 추가한다. 예시 파일은 [backend-hermes-search.patch.yaml](../../infra/k3s/backend-hermes-search.patch.yaml)에 있다. 테스트 UUID를 채우고, 기본 배포 뒤에 적용한다.

```sh
# master: 이미 배포된 mori-api에 적용. UUID 예시를 반드시 실제 값으로 수정.
sudo k3s kubectl -n mori patch deployment mori-api --type strategic \
  --patch-file infra/k3s/backend-hermes-search.patch.yaml
sudo k3s kubectl -n mori rollout status deployment/mori-api --timeout=300s
```

`API_SERVER_KEY`는 기존 `mori-hermes` Secret에서 참조한다. API 자체에는 Kubernetes Secret을 조회할 RBAC 권한을 주지 않는다.

master 터미널 A:

```sh
sudo k3s kubectl -n mori port-forward service/mori-api 8000:8000 --address=127.0.0.1
```

master 터미널 B (소스 저장소 루트):

```sh
python3 backend/scripts/test_assistant_search.py
```

실제 소셜 로그인으로 받은 **Mori access_token**을 숨김 입력한다. 스크립트는 인증 없는 요청의 401, `/v1/me` 인증, 검색 성공 및 도구 결과를 확인한다. 이 검사는 검색 요청을 실행하므로 GPU를 사용한다. 출력된 답변을 추출 결과와 대조해 사실 정확성을 확인한다. 이 절은 소셜 로그인 경로다. 페이지 없이 검사하려면 별도의 검색 전용 임시 토큰 경로를 사용한다.

## 개발 검증

`tests/test_assistant.py`는 실제 PostgreSQL 인증을 사용하고 Hermes HTTP만 MockTransport로 대체한다. 성공 응답, 직접/간접 도구 호출, 외부 데이터 태그, 사용자 제한, 입력 제한, 도구 설정, 타임아웃·상류 오류·빈 검색 결과·잘못된 call_id 등을 검사한다.

```sh
cd backend
uv sync --frozen
MORI_TEST_POSTGRES_URL=postgresql+psycopg://mori:mori-local-only@127.0.0.1:55432/mori uv run pytest
uv run ruff check .
uv run ruff format --check .
uv run python scripts/export_openapi.py --check
```

실제 k3s → Hermes → llama.cpp → SearXNG/추출 연동은 배포 후 별도 검사한다.

[Hermes 공식 API 문서](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)
