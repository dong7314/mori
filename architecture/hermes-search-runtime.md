# Hermes 경량화와 자체 호스팅 검색 방향

[전체 계획](../plan.md) · [아키텍처](plan.md) · [공용 Hermes 재개 절차](hermes-shared-resume.md)

갱신일: 2026-09-21. 사용자 의도는 보유한 서버에서 검색을 운영해 외부 검색 API 비용을 피하고, 공용/개인 Hermes를 가볍게 유지하는 것이다. **SearXNG를 첫 검증 후보로 삼으며 아직 배포·연동하지 않았다.** 이하 분리 구조와 자원 정책은 설계안이고 경량 이미지는 존재하지 않는다.

## 1. 실행 이미지와 자원 제한

- 첫 연결은 공식 Hermes 이미지의 고정 버전/digest로 검증한다. 직접 빌드나 Harbor 등록은 선행 필수가 아니다.
- 이후 모리 전용 공통 이미지를 만들고 Free 공용·Pro 개인에 같은 이미지를 사용하는 안을 우선 검토한다. CPU/RAM 차이는 Kubernetes requests/limits로 설정한다. 작은 limits만으로 소프트웨어가 경량화되는 것은 아니다.
- Hermes에는 추론 반복, 도구 호출 클라이언트, 기억·스킬 접근을 남기고, 브라우저·파일 변환·OCR·음성 처리처럼 무거운 실행은 필요할 때 별도 Worker로 분리한다.
- 이미지 크기, 실행 중 RSS, 기동 시간은 서로 다른 지표다. 공식 이미지의 불필요한 의존성 제거는 고정한 버전에서 API·도구·기억 기능의 회귀를 검증하며 진행한다. 특정 메모리 절감량을 약속하지 않는다.
- RTX 3090의 모델 가중치는 기존 독립 llama.cpp 서버에 유지한다. 개인 Hermes마다 모델을 적재하지 않는다.

## 2. 검색과 본문 추출을 구분한다

| 후보 | 역할과 연결 | 현재 판단 |
| --- | --- | --- |
| SearXNG | 외부 검색 엔진들의 결과를 집계. Hermes 기본 `searxng` provider와 JSON API로 연결 | 첫 자체 호스팅 검색 후보 |
| YaCy | 직접 크롤링·색인하거나 P2P 색인 사용, 컨테이너 제공 | 특정 범위 자체 색인에는 검토 가능. 일반 웹의 범위·최신성을 직접 운영해야 하므로 초기 모리의 우선안은 아님 |
| Crawl4AI | URL 본문 수집·브라우저 처리, 자체 호스팅 API/MCP | 후속 본문 추출 후보. Hermes 도구/어댑터 연결과 버전별 API 검증 필요 |
| Firecrawl 자체 호스팅 | Hermes가 사용자 지정 API 주소를 지원. 본문 수집·추출 등 제공 | 연결 후보지만 API/Worker·브라우저·큐·DB 등 구성 요소가 많아 초기 경량화 목적과 비교 필요 |

SearXNG는 인터넷 전체를 자체 색인하는 서버가 아니다. API 키/유료 계약이 필요 없는 upstream 엔진만 활성화하면 외부 검색 API 사용료 없이 운영할 수 있다. 그래도 전기·CPU/RAM·네트워크·유지보수 비용이 있고 upstream 차단·CAPTCHA·호출 제한이 발생할 수 있다. 자체 호스팅을 무제한·무장애 검색으로 표현하지 않는다. 검색 질의는 설정한 외부 검색 엔진에 전달된다.

Tavily/Brave 등 외부 API의 무료 한도도 비교했지만, 현재의 우선 검증은 자체 호스팅이다. 무료 제공량·요금표를 설계 의존성으로 두지 않는다. 공급자별 원문 저장·재사용 조건도 동일하다고 가정하지 않는다.

## 3. 초기 k3s 배치 제안

```mermaid
flowchart TD
    Mori[Mori API / 사용자·작업 문맥] --> Shared[Free 공용 Hermes]
    Mori --> Personal[Pro 개인 Hermes — 후속]
    Shared --> LLM[기존 llama.cpp / 192.168.0.8:8080]
    Personal --> LLM
    Shared --> Search[공용 SearXNG / 내부 Service]
    Personal --> Search
    Search --> Upstream[설정한 외부 검색 엔진]
    Shared -. 필요한 URL 본문 .-> Extract[본문 추출 Worker — 후속]
    Personal -. 필요한 URL 본문 .-> Extract
    Mori --> DB[(사용자별 대화·작업·검색 이력)]
```

- 배포 명령은 master에서 실행하고 SearXNG workload는 `k3s-infra`의 selector/toleration에 맞춘다.
- 초기에는 공유 Deployment 1개와 ClusterIP로 구성하는 안이다. 별도 검색 GPU, 사용자별 검색 Pod, 공개 Ingress/포트포워딩은 필요하지 않다.
- SearXNG 설정은 ConfigMap/Secret으로 관리하고 JSON 출력을 활성화한다. 이미지 버전/digest를 고정한다. Valkey를 요구하는 limiter 등 기능을 선택하면 그 의존성도 함께 배포한다. 이를 무조건 단일 Pod로 모두 해결된다고 보지 않는다.
- 초기 공유 검색은 상시 운영을 제안한다. 개인 Hermes의 scale-to-zero와 검색 서비스의 수명을 분리한다. 자원 requests/limits·동시 검색 수는 부하를 측정해 정한다.
- JSON 검색에 브라우저 Pod가 필수인 것은 아니다. 링크 본문이나 JavaScript 페이지 처리는 별도로 붙인다.

설정 방향 예시(아직 적용하지 않음): Service 이름 `searxng`, namespace `mori-tools`, Service port 8080을 **그렇게 배포했을 때** 사용하는 주소다. 현재 존재하는 리소스가 아니다.

```yaml
# Hermes config.yaml
web:
  search_backend: searxng
  keyless_fallback: false
  keyless_rescue: false
```

```text
SEARXNG_URL=http://searxng.mori-tools.svc.cluster.local:8080
```

```yaml
# SearXNG settings.yml의 일부 — 완전한 배포 설정 아님
search:
  formats:
    - html
    - json
```

외부 무료 서비스로 자동 전환되지 않게 fallback/rescue를 끄는 방향이며 고정한 Hermes 버전에서 키를 확인한다. SearXNG는 Hermes의 `web_search`만 제공한다. `web_extract`까지 동작한다고 간주하지 않으며 본문 제공자를 정하기 전 해당 호출은 제공하지 않는다. Crawl4AI를 기본 provider 이름으로 임의 지정하지 않는다.

## 4. 공유 검색과 개인 기록

검색 실행 위치와 기록의 소유자는 별개다. 공용 SearXNG를 사용해도 개인 Hermes는 자신의 맥락·선호로 검색어를 만들고 결과를 해석할 수 있다. 이로써 사용자 이력 저장이 자동 구현되지는 않는다.

- Mori에서 인증 문맥으로 `user_id`, `conversation_id`, `run_id`를 결정한다. 모델이 제안한 사용자 ID를 권한으로 신뢰하지 않는다.
- 도구 실행 이력에 검색어·시각·실제 제공자·성공/오류·출처를 연결한다. 원문/요약 보관 범위·기간은 제공자 조건과 제품 삭제 정책에 맞춰 정한다.
- 공용 SearXNG에는 검색에 필요한 질의만 보내고 개인 대화 전체나 내부 사용자 식별자를 불필요하게 넘기지 않는다.
- 개인화 이력은 Mori DB와 사용자별 Hermes 상태에 둔다. 공유 검색 로그를 개인 기억 저장소로 사용하지 않는다.
- 검색/본문/브라우저 캐시, 쿠키, 파일, 삭제 범위는 사용자 경계에 맞춘다. 도구 분리만으로 사용자 격리가 보장되지는 않는다.
- 본문 추출 Worker에는 내부 주소·리다이렉트 검증, 응답 크기·시간·동시 실행 제한을 둔다. 웹페이지 지시는 실행 권한으로 취급하지 않는다.

## 5. 구현 순서와 인수 기준

1. 공식 이미지로 공용 Hermes↔기존 llama.cpp 일반 대화를 확인한다.
2. SearXNG의 고정 이미지·설정·내부 Service를 준비하고 JSON 검색의 비어 있지 않은 결과와 upstream 오류를 확인한다.
3. Hermes에서 실제 `web_search` 호출과 도구 결과를 받은 뒤의 후속 모델 응답을 확인한다. 모델이 기억으로 답하거나 검색했다고 주장한 것만으로 통과시키지 않는다.
4. 한국어 질의·검색 실패·연속 요청을 검증하고 동시성·timeout·일시 차단 시 동작을 정한다. 공용 서비스 전체의 호출량을 관리한다.
5. Mori Adapter에 사용자별 도구 이력을 연결한다. 최소 두 계정으로 이력/결과 접근 격리를 검증한다.
6. 필요해지면 자체 호스팅 본문 추출과 파일 Worker를 추가하고 Hermes 이미지의 불필요한 패키지를 제거한다. 기능 회귀·기동 시간·메모리를 측정한다.

## 공식 근거

2026-09-21 확인. 제품 버전 선택 시 구현과 문서의 차이를 다시 확인한다.

- [Hermes Web Search & Extract](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-search): SearXNG, 검색/추출 분리, self-hosted Firecrawl 주소, keyless 설정.
- [Hermes Docker](https://hermes-agent.nousresearch.com/docs/user-guide/docker): 공식 이미지, Gateway API, `/opt/data` 상태 보존.
- [SearXNG 컨테이너](https://docs.searxng.org/admin/installation-docker.html), [검색 API](https://docs.searxng.org/dev/search_api.html), [limiter](https://docs.searxng.org/admin/searx.limiter.html): 배포, JSON, upstream 차단과 Valkey 의존성.
- [YaCy](https://yacy.net/), [컨테이너 설치](https://www.yacy.net/download_installation/): 자체 색인/P2P와 Docker 지원.
- [Crawl4AI 자체 호스팅](https://docs.crawl4ai.com/core/self-hosting/): 서버·API·본문 추출. 버전별 인증·기본값 차이는 선택한 릴리스로 검증한다.
- [Firecrawl 자체 호스팅](https://github.com/firecrawl/firecrawl/blob/main/SELF_HOST.md): 구성 요소, Kubernetes 예시, 버전 고정 필요.
