# 공용 Hermes 검색·이미지·본문 추출 검증 기록

[전체 계획](../plan.md) · [아키텍처](plan.md) · [검색 실행 구조](hermes-search-runtime.md) · [이미지·YAML 전환 계획](runtime-image-transition.md) · [Mori API 구현 현황](../back/hermes-search-implementation-2026-09-28.md)

기록일: 2026-09-28. 근거는 사용자가 제공한 k3s 터미널 출력·첨부 로그와 전달한 실습 스크립트다. 이번 문서 정리 중 원격 클러스터에 접속하거나 재검증하지 않았다. 실행 성공, 답변 품질, 제품 연동 완료를 구분한다. IP·Pod 이름·버전·소요 시간은 해당 출력 시점의 관측값이다.

> 이 문서의 시험 출력은 **실습 환경 삭제 전의 이력**이다. 이후 삭제를 사용자 출력으로 확인했고 새 이미지·YAML을 코드화했다. 현재 리소스가 Running이라는 의미로 읽지 않는다. 최신 재개 순서는 [전환 기록](runtime-image-transition.md)을 따른다.

## 1. 삭제 전에 어디까지 검증했는가

| 구간 | 확인한 결과 | 아직 확인하지 않은 것 |
| --- | --- | --- |
| 공용 Hermes → llama.cpp | health 200, 실제 한국어 인사 응답 | 다중 사용자 격리, 성능·동시 요청 한계 |
| Hermes Pod → SearXNG | 내부 Service를 통한 JSON 검색, 결과와 엔진 오류 확인 | 장시간 안정성·부하·차단 복구 |
| 모델 → `web_search` → 모델 | 실제 호출·성공 결과·최종 출처 링크 확인 | 모든 답변 문장의 사실 정확성 |
| 여행 계획 요청 | 여러 차례 검색하고 계획 형태로 답변 | 환승·경로·시간 정확성, 일정 DB 저장, PDF/Excel 생성 |
| Google/Naver 이미지 검색 | 두 엔진에서 이미지 후보 URL와 출처 URL 반환 | 실제 이미지 로딩·사진 내용·프론트 표시 |
| 모델 → `mori_image_search` | `tool_call` 간접 호출과 결과 URL 쌍 3개 확인 | 모델의 Naver 경로 별도 검증, 이미지 시각적 확인 |
| 로컬 Trafilatura | 공식 안내 HTML 다운로드·본문 추출 | JavaScript 렌더링, PDF·이미지 본문 처리 |
| 모델 → `web_extract` | 직접 추출 및 검색 후 추출·출처 답변 통과 | 다양한 사이트 회귀·추출 누락·동시성 |
| Mori API → 기존 Hermes | 로컬 구현·모의 상류 테스트까지 진행 | 실제 k3s 통합 호출은 미실행 |
| 실제 Hermes scale-to-zero | 미완료, 시험 당시 일반 Deployment | Knative 전환·home 복원·작업 중 종료 방지 |

**현재 완료한 것은 공용 Hermes의 검색 도구 연결 실험이다. 개인 비서 제품 전체의 검증 완료가 아니다.** 주차 자연어 저장·조회, 사용자별 기억, 예약·위젯·문서 생성은 각각 후속 기능이다.

## 2. 시험 당시 실행 위치와 클러스터 구성

| 위치 | 역할 | 이번 작업에서의 의미 |
| --- | --- | --- |
| k3s master: `k3s-server`, `192.168.0.100` | `sudo k3s kubectl`, 실습 Python 스크립트 실행 | Python 명령을 입력한 곳이다. 검색/추론이 모두 master에서 실행된다는 뜻은 아니다. |
| k3s worker: `k3s-infra`, `192.168.0.20` | Hermes·SearXNG workload | `kubectl exec`가 실행하는 Python과 도구는 해당 Pod 안에서 동작한다. |
| 별도 GPU 노트북: `192.168.0.8:8080` | RTX 3090 eGPU, llama.cpp | Hermes가 네트워크로 모델 호출. 현재 k3s 노드가 아니다. |

2026-09-28 삭제 전 사용자 출력의 리소스:

| 항목 | 값 |
| --- | --- |
| Hermes namespace / Deployment / container | `mori` / `mori-hermes-shared` / `hermes` |
| Hermes Service | `mori-hermes-shared.mori.svc.cluster.local:8642`, ClusterIP `10.43.188.35` |
| 마지막으로 제시된 Hermes Pod | `mori-hermes-shared-5f5b84bffc-lknzg`, `1/1 Running`, 재시작 0, `10.42.1.141`, `k3s-infra` |
| Hermes 이미지 — Deployment 출력 | `nousresearch/hermes-agent@sha256:d43ac4ef5c76ec063342cd1cb1c1f839ce73acffa9445bee87bbccfd39ccb808` |
| Hermes home | PVC `mori-hermes-shared-home`, 5Gi, RWO, `local-path`, `/opt/data` |
| Hermes 설정 | ConfigMap `mori-hermes-config`의 `config.yaml`, 실행 파일 `/opt/data/config.yaml` |
| SearXNG namespace / Deployment / container | `mori-tools` / `searxng` / `searxng` |
| SearXNG Service | `searxng.mori-tools.svc.cluster.local:8080`, ClusterIP `10.43.197.170` |
| 처음 확인한 SearXNG Pod | `searxng-6cbc94b45f-5qkkm`, `1/1 Running`, 재시작 0, `10.42.1.135`, `k3s-infra` |
| SearXNG 런타임 버전 출력 | `2026.9.25-12f8b6515` |
| Mori API | 사용자는 미배포라고 확인했고, 제시된 `mori` Deployment/Service 목록에도 없음 |

Hermes Pod 이름 변경은 설정 적용·rollout 과정의 기록이다. 위의 Pod IP나 ClusterIP를 제품 코드에 고정하지 않고 Service DNS를 사용한다. SearXNG 최종 이미지 digest와 컨테이너 `imageID`는 다음 설정 수집 때 확인한다. 실습 YAML의 이미지 값과 실제 실행 이미지를 같은 것으로 간주하지 않는다.

### 앞선 인프라 검증과의 연결

- worker의 `10250` timeout으로 metrics가 `<unknown>`이었으나 UFW에 master 및 필요한 Pod 대역을 허용한 뒤 두 노드의 `top nodes`와 오류 없는 최신 로그를 확인했다. worker 자체에서 받은 HTTP 401은 kubelet 접근 성공·인증 필요를 뜻했으며 원격 경로 성공의 증거는 아니었다.
- 외부 SSH의 `os error 61`은 사용자가 ipTIME 포트포워딩 포트 오기입을 수정해 해결했다. Harbor의 HTTPS 접근과 SSH, kubelet 메트릭은 서로 다른 포트·경로였다.
- Knative/Kourier와 샘플의 1→0→1은 통과했다. `Hello Mori!`의 `real 1.140s`를 실제 Hermes/LLM의 콜드 스타트 시간으로 사용하지 않는다.
- GPU 컨텍스트·인증 문제 및 첫 인사는 [9월 23일 별도 이슈 기록](hermes-llama-validation-2026-09-23.md)과 [첫 대화 기록](hermes-shared-validation-2026-09-23.md)에 보존했다. 장비 검증을 처음부터 다시 시작하지 않는다.
- Oracle A1 ARM 2코어·12GB의 별도 실행/worker 합류는 검토했으나 사용자가 후순위로 미뤘다. 현재 테스트가 Oracle에서 수행된 것으로 기록하지 않는다.

## 3. SearXNG 설치 후 직접 검색

master 작업 디렉터리: `/home/dongyeop/mori-searxng-lab-20260928`.

`search-test.py`는 Hermes Pod 안에서 SearXNG health 및 JSON 검색을 실행했다. 초기 엔진 조합은 DuckDuckGo와 Bing이었다.

| 검색어 | 소요 | 결과 수 | 실패/제한 엔진 |
| --- | --- | --- | --- |
| 서울 관광 공식 사이트 | 0.86초 | 17 | `[]` |
| 부산 관광 공식 사이트 | 0.77초 | 18 | `[]` |

`top pods --containers`에서 SearXNG CPU `4m`, 메모리 `81Mi`를 관측했다. 이는 한 시점의 사용량이며 최대 부하, 장기 평균, 적절한 requests/limits를 확정하는 자료가 아니다.

처음 스크립트가 제목·URL만 출력해 본문을 제공하지 않는 것처럼 보였다. `content` 설명을 추가로 출력하자 서울 검색에서 0.81초·13개 결과와 설명이 확인됐다. 이 설명은 검색 엔진의 **스니펫**이며 링크 본문 전체가 아니다. URL이 HTTPS인 것은 모델이 참고하지 못하는 이유가 아니다. 도구가 검색 설명 또는 실제 본문 텍스트를 모델에 돌려주는지가 핵심이다.

### Pod 통신 성공과 Hermes 도구 설정을 분리한 검사

초기 `inspect-hermes.py` 출력:

```text
runtime_config_path: /opt/data/config.yaml
runtime_matches_configmap: true
multiplex_profiles: false
web.backend: unset
web.search_backend: unset
web.keyless_fallback: false
web.keyless_rescue: false
SEARXNG_URL_present: false
```

이 시점에는 네트워크 검색만 성공했고 Hermes 모델의 도구 제공자는 연결 전이었다. 이후 `web.search_backend=searxng`, 내부 `SEARXNG_URL`을 적용한 뒤 `web enabled=True configured=True`와 실제 모델 검색을 확인했다. 위 설정 일치 검사는 당시 상태의 증거이며 이후 모든 수동 변경까지 일치한다는 보장은 아니다.

## 4. 모델 web_search와 검사기 보완

첫 `hermes-web-test.py` 결과는 실제 `web_search` 1회, 정상적으로 보이는 최종 답변에도 FAIL이었다. 실패 지점은 **외부 데이터 태그로 감싼 도구 결과를 검사기가 해석하지 못한 부분**이었다. 모델이 “검색 성공”이라고 쓴 문장만으로 이를 PASS로 바꾸지 않았다.

v2는 외부 데이터 태그 안의 JSON을 해석하고 도구 호출과 반환 결과를 연결하도록 보완했다.

```text
실제 web_search 호출 수: 1
검색 인자: {"query":"서울 관광 공식 사이트"}
도구가 반환한 유효 검색 결과 수: 5
PASS: 실제 web_search 호출, 비어 있지 않은 성공 결과, 최종 답변의 출처 링크 확인
```

최종 답변에는 Visit Seoul 등 출처가 포함됐다. 이 검사는 웹 검색 실행을 증명하며, 본문 추출이나 모든 문장의 정확성을 증명하지 않는다. 이후 이미지 도구 검사에서도 같은 원칙을 적용했다.

## 5. 검색 품질·언어·CAPTCHA 문제와 엔진 변경

### 관측된 문제

| 문제 | 로그의 증거 | 판단 |
| --- | --- | --- |
| DuckDuckGo CAPTCHA | `unresponsive_engines`에 `["duckduckgo", "CAPTCHA"]` | 해당 엔진의 실패다. SearXNG 자체 health 성공과 양립한다. |
| Bing 관련성 저하 | 박물관 검색에 국립중앙도서관·국립국어원, `site:museum.go.kr 관람시간`에 영화 `Sssssss` 결과 | 당시 결과를 일정 판단에 쓰기 부적합했다. 원인을 언어 코드 하나로 확정할 수 없다. |
| site 검색의 기관 혼동 | Brave에서 `naju.museum.go.kr` 결과 | 상위 도메인 조건에는 맞아도 국립중앙박물관과 다른 기관이다. 기관명·정확한 호스트를 함께 확인해야 한다. |
| 중국어 혼입 | 여행 답변에 `核实(확인)` 등의 표현 | 최종 생성 언어 문제도 구분해야 한다. SearXNG의 언어 설정이 직접 원인이라는 증거는 부족하다. |
| 스니펫 간 시간 불일치 | 관람 안내와 다른 검색 페이지에서 9:30/10:00 등 차이 | 해당 공식 안내 본문·적용 날짜 확인이 필요하다. 검색 상위 순서만으로 선택하지 않는다. |

실행 중 설정 검사에서는 `search.default_lang=ko-KR`, `formats=['html','json']`, Bing/DuckDuckGo 활성화와 기본 base URL을 확인했다. `ko-KR` 문자열이 출력됐다는 사실만으로 오류라고 단정하지 않는다. 진단 응답의 검색어가 원문과 같아도 upstream에 실제 전달된 모든 파라미터가 올바르다는 증거는 아니다. 최종 언어 설정은 서버 설정을 다시 수집해 확정해야 한다.

사용자가 참고한 다른 사람의 설정은 `keep_only`, Google/Naver 세로 검색, `default_lang: ko` 등을 포함했다. 다만 Naver XPath의 `results_xpath`·`url_xpath`가 비어 있는 예시는 완성된 배포 설정이 아니므로 그대로 제품 설정으로 채택하지 않는다. 현재 Naver의 실제 parser 설정도 최종 설정 수집 대상이다.

### 최종 확인한 일반 검색 조합: Google + Naver + Brave

| 검색어 | 소요 | 결과 수 | 관측 |
| --- | --- | --- | --- |
| 국립중앙박물관 | 0.61초 | 37 | 공식 홈페이지가 상위, Google/Brave/Naver 결과 병합, 실패 엔진 없음 |
| `site:www.museum.go.kr 국립중앙박물관 관람시간` | 0.57초 | 41 | 공식 관람 안내가 상위, 실패 엔진 없음 |
| 이미지 추가 후 국립중앙박물관 회귀 | 0.59초 | 37 | 일반 검색 유지, 실패 엔진 없음 |

위 질의에서는 이전 조합보다 관련성이 개선됐다. Google/Naver/Brave가 항상 차단 없이 동작하거나 한국어 검색 품질을 보장한다는 결론은 아니다. SearXNG의 `brave` 엔진 사용을 유료 Brave API 연동 완료와 혼동하지 않는다. DuckDuckGo CAPTCHA가 해제됐다는 증거는 없으며 현재 검증 조합에서 제외해 진행했다. 최종 활성 엔진 전체 목록은 실행 설정을 보존할 때 수집한다.

### 여행 계획과 환승 문제

여행 요청에서 검색을 반복한 뒤 일정 형태로 답변하는 흐름은 동작했다. 그러나 첨부 로그에는 서울역→시청을 4호선으로 안내하거나 서울역→경복궁역을 1호선 몇 정거장으로 설명하는 등 잘못된 교통 안내가 있었다. 이는 **오답 기록**이며 이동 안내로 재사용하지 않는다.

한 시험은 실제 도구 이벤트가 12회인데 답변이 8회라고 주장했다. 이후 엔진 변경 시험은 7회 검색 이벤트를 확인했다. 호출 횟수는 모델의 자기 설명이 아니라 실제 이벤트를 기준으로 집계한다.

Google Maps/Naver Map 관련 검색을 추가하는 것과 출발·도착·시각을 입력받는 경로 계산 도구는 별개다. 이미지·영상 카테고리를 추가한 방식만으로 환승 노선·도보·소요 시간이 검증되지는 않는다. 현재 별도 경로 도구는 구현하지 않았다. 후속 여행 기능에서는 공식 장소 본문과 이동 구간 검증을 분리하고 미확인 이동 시간은 단정하지 않는다.

## 6. 이미지 검색: JSON 후보 → Hermes 도구

### 엔진 직접 검사

`google images`: 0.60초, 전체 69개 중 유효 이미지 결과 20개. `naver images`: 0.29초, 전체 69개 중 유효 이미지 결과 48개. 두 검사 모두 실패 엔진이 없었지만 실제 이미지 바이트를 내려받은 검사는 아니었다. 집계된 전체 수를 각 엔진 단독 결과 수로 해석하지 않는다.

### 기존 Hermes Pod에 플러그인 추가

master 디렉터리: `/home/dongyeop/mori-image-lab-20260928`.

| 항목 | 값 |
| --- | --- |
| 플러그인 위치 | `/opt/data/plugins/mori_images` |
| 도구 세트 / 도구 이름 | `mori_images` / `mori_image_search` |
| 주요 인자 | `query`, `engine` (`google` 또는 `naver`), `limit` |
| 반환 | 제목, `image_url`, `source_url`, 엔진, `image_verified: false` |
| 추가 메타데이터 | 실패 엔진, 제목 기반 상품 필터 제외 수, `external_data_untrusted: true` |

별도 이미지 검색 Pod를 추가하지 않았다. Hermes 플러그인이 공용 SearXNG를 호출한다. 실습 구현은 엔진별 bang을 사용하고 입력·URL 형식을 제한한다. 제목에 상품 표현이 있는 후보를 제외하는 것은 휴리스틱이며 사진 관련성 검증을 대체하지 않는다.

`direct-test.py`는 Google과 Naver에서 각각 후보 3개, `2/2 engines`, `DIRECT_TEST_PASS`를 반환했다. Naver의 상품 제목 후보 1개가 제외됐다. URL 후보의 반환 성공이지 이미지 로딩 성공이 아니다.

### 간접 호출을 빠뜨린 검사기 수정

첫 모델 시험에서 관측한 외부 도구 이름은 `tool_describe`, `tool_call`이었다. 검사기는 `mori_image_search` 직접 호출만 세어서 0회·FAIL로 판정했다. 최종 답변의 URL만 보고 성공을 추정하지 않고 검사기를 수정했다.

v2 결과:

```text
호출 경로: tool_call → mori_image_search
검색 인자: {"query":"경복궁 전경","engine":"google","limit":3}
요청 수: 1
유효 이미지 후보: 3
실패/제한 엔진: []
성공 결과가 확인된 이미지 도구 호출 수: 1
PASS: 실제 도구 호출, 성공 결과, 최종 답변 URL 쌍 3개 확인
```

`tool_call`의 인자에서 실제 대상 도구를 확인하고 호출 ID에 대응하는 성공 결과를 해석했다. 단순 `tool_describe`나 모델의 “성공했다”는 문장은 실행 증거가 아니다. 이후 남은 것은 이미지 URL의 실제 접근, 사진 내용, 앱 렌더링 검증이다.

## 7. 본문 추출: 미설정 진단 → 로컬 추출 → 모델 연결

### 추출 제공자 부재를 먼저 확인

초기 검사에서 `search_backend=searxng`, `extract_backend` 미설정, fallback/rescue false였다. 선택된 추출 backend가 `searxng`로 귀결되어 “SearXNG는 search-only이며 URL 본문을 추출할 수 없다”는 오류가 반환됐다. 기본 Python에는 `trafilatura`, `bs4`, `lxml`, `readability`가 모두 없었다.

이는 검색 실패가 아니라 **본문 추출 경로가 아직 없다는 진단**이었다. 새 브라우저 Pod 대신 기존 Hermes 안에 로컬 본문 추출을 먼저 붙였다.

### 별도 가상환경에서 직접 추출

```text
Python: /opt/data/tool-envs/mori-extract/bin/python
trafilatura: 2.2.0
URL: https://www.museum.go.kr/MUSEUM/contents/M0101000000.do
HTTP: 200
Content-Type: text/html
최종 URL: 요청 URL과 동일
소요: 0.32초
추출 문자 수: 1363
저장: /opt/data/extract-tests/museum-20260928T050202Z.txt
관람시간 문구: True
휴관/휴실 문구: True
```

직접 시험은 `urllib.request`로 HTML을 받고 Trafilatura로 텍스트를 만들었다. 프록시 미사용, 30초 요청 timeout, HTML 2MB 제한을 두었다. 고정된 공식 URL의 실험 코드이지 임의 URL을 처리하는 제품 도구의 완성본은 아니었다.

사용자가 제공한 추출 본문에는 요일별 관람시간·입장 마감, 휴관/정기휴실일, 옥외 전시장, 요금 등이 포함됐다. 당시 본문은 일반 요일 9:30–17:30, 수·토 9:30–21:00과 각각 30분 전 입장 마감을 표시했다. **이 값은 당시 추출 내용을 대조하기 위한 기록이며 이후 방문 시점의 최신 안내를 보장하지 않는다.**

### `mori-local` provider로 기존 web_extract 연결

master 디렉터리: `/home/dongyeop/mori-extract-lab-20260928`.

| 항목 | 구성 |
| --- | --- |
| 플러그인 | `/opt/data/plugins/mori_extract` |
| 제공자 | `mori-local`, 검색 미지원·본문 추출 지원 |
| Hermes 설정 | `web.search_backend: searxng`, `web.extract_backend: mori-local` |
| 모델이 호출하는 이름 | 기존 `web_extract` 유지 |
| 실행 방식 | 기존 Hermes 프로세스에서 전용 venv의 worker Python을 subprocess로 실행 |
| 배포 형태 | 기존 Deployment 설정 갱신·재시작, 새 본문 추출 Pod 없음 |

실습 설치기는 고정 Hermes 이미지·현재 config와 ConfigMap의 일치·단일 profile·web 도구·Trafilatura 버전 등을 확인하고 설정 백업 후 플러그인을 추가한다. 기존 `mori_images`를 보존하며 ConfigMap 갱신 후 rollout한다. 롤백 스크립트는 자신이 설치한 설정과 현재 설정이 같은지 확인하고 설정을 복원한다. 플러그인 파일까지 모두 지우는 전체 복구와는 다르며, 실제 롤백 실행은 보고되지 않았다.

추출 worker 구현에는 HTTP(S)·표준 포트 제한, 공개 IP 확인과 연결 IP 고정, 리다이렉트 재검사, TLS 검증, HTTPS 하향 전환 거부, URL 개수·본문 크기·시간 제한을 두었다. 실습 기준은 최대 3개 URL, URL별 25초, HTML 2MB, 추출 최대 100,000자와 최소 유효 길이 200자다. HTML 차단 화면 탐지는 완전하지 않다. 브라우저 JavaScript 실행·PDF·이미지 다운로드 기능은 추가하지 않았다.

### 모델 직접 추출 및 검색→추출 시험

사용자 첨부 로그에서 다음 두 경로가 통과했다.

1. `hermes-extract-test.py`: 지정 공식 URL을 실제 `web_extract`로 요청 → 유효 본문 1,407자 → 본문 기반 답변·출처.
2. `hermes-extract-test.py --search`: 실제 `web_search`에서 목표 공식 URL 확보 → `web_extract` 1,407자 → 관람 안내 답변·출처.

직접 텍스트 시험의 1,363자와 provider 결과의 1,407자는 출력 형식 차이가 있으므로 문자 수만으로 회귀를 판단하지 않는다. 도구 캐시가 사용될 수 있어 모든 호출이 새로운 네트워크 다운로드였다고 단정하지 않는다.

일부 답변은 전시실별 휴실 설명을 과하게 “미확인” 처리했다. 원문에 상설전시관·특별전시실 1·2 관련 내용이 있었으므로 요약 충실도는 개선 대상이다. 연결 성공과 답변 품질을 별개로 평가한다.

## 8. 시험 당시 실습 파일과 재현성의 한계

실습 패키지는 개발 PC의 `.codex/artifacts/mori/` 아래 디렉터리·압축본으로 전달했고 master의 `/home/dongyeop/` 아래에서 실행했다. 시험 당시에는 정식 이미지 밖의 설치물이었다. 이후 필요한 플러그인·의존성·검사기는 `master` `2e2a397`에 편입했으며 과거 installer/rollback 전체를 그대로 제품화한 것은 아니다.

| 패키지 | 주요 파일 | 용도·주의 |
| --- | --- | --- |
| `mori-hermes-lab-20260922` | `prepare.py`, `chat-test.py`, `hermes-shared.template.yaml` | 첫 Pod·PVC·대화 실험. 초기 profile 설정을 최신 설정으로 간주하지 않는다. |
| `mori-searxng-lab-20260928` | `searxng.yaml`, `search-test.py`, `inspect-hermes.py`, `hermes-web-test.py`, `search-quality-test.py` | 검색 연결·품질 확인. 초기 YAML의 DuckDuckGo/Bing은 최종 Google/Naver/Brave 설정과 다르다. |
| `mori-image-lab-20260928` | `install.py`, `rollback.py`, `mori_images/`, `direct-test.py`, `hermes-image-test.py`, `evidence.py` | 이미지 도구·직접/간접 호출 검사. 시험 당시 코드가 PVC에 놓여 있었다. |
| `mori-extract-lab-20260928` | `install.py`, `rollback.py`, `mori_extract/`, `direct-extract-test.py`, `hermes-extract-test.py`, `evidence.py` | 로컬 추출 provider와 검사. venv도 PVC에 설치했다. |

설정이 달라진 상태에서 예전 YAML을 다시 apply하면 검색 엔진·profile·플러그인 설정이 되돌아갈 수 있다. 초기 `master`의 `hermes-shared.yaml`도 모든 현장 설정을 반영하지 않았으며 이후 `2e2a397`에서 제거하고 Kustomize로 대체했다. 플러그인·검사기·의존성은 이미지 소스로 편입했다. 삭제된 최종 SearXNG ConfigMap의 전체 export는 없으므로 확인한 엔진 조합과 고정 릴리스 내장 parser로 재구성했다.

## 9. 증거 해석과 이후 검증 기준

검사기는 다음을 따로 기록해야 한다.

1. HTTP/health와 네트워크 접근.
2. 모델의 실제 도구 호출 이름·인자·호출 ID.
3. 그 호출에 대응하는 성공/실패 결과와 유효 데이터 수.
4. 최종 답변에 반환한 실제 출처와 결과의 일치.
5. 사람이 검토한 사실 정확성·누락·사용 가능성.

`PASS`의 범위를 반드시 함께 출력한다. 성공 문자열만 검색하거나 `tool_describe`를 실행으로 세지 않는다. 도구의 외부 데이터 태그와 `tool_call` 경로를 지원하되 일치하지 않는 결과는 자동 성공 처리하지 않는다.

남은 검증:

- [ ] 정식 이미지에서 search / image search / extract / search→extract 회귀.
- [ ] 이미지 실제 로딩·프론트 표시, 여행의 이동 구간 검증.
- [ ] Mori API를 통한 실제 호출·인증 거부·임시 토큰 비활성화.
- [ ] 사용자별 데이터 접근 격리와 실제 주차 도구의 DB 저장/조회.
- [ ] PVC 복원·단일 작성자·실제 Hermes Knative 재기동.
- [ ] 검색 실패·CAPTCHA·동시 요청·timeout의 운영 동작과 자원 측정.

실습 삭제와 이미지/YAML 코드화는 이후 완료됐다. 지금의 우선순위는 [새 이미지의 Harbor 등록·재배포 및 실제 도구 회귀](runtime-image-transition.md)다. 백업 없이 테스트 데이터를 폐기하기로 한 사용자 결정을 반영하며, 삭제한 home 데이터가 복구된다고 가정하지 않는다.

## 10. 근거 로그와 다음 재확인 위치

| 근거 | 이 문서에서 사용한 내용 |
| --- | --- |
| 대화에 붙인 k3s·Python 출력 | Pod/Service/PVC, SearXNG 수치, provider 설정, 이미지 v1/v2, 직접 Trafilatura 추출 |
| 첨부 `9dfa261d-dd5d-4c39-83b7-eb3ffc8909b0` | 초기 여행 요청의 반복 검색, 모델이 말한 호출 수와 이벤트 수의 차이 |
| 첨부 `d2bfc687-a033-4d5f-8697-58bfbe4505dc` | 검색 품질 진단, query echo와 엔진 오류의 구분 |
| 첨부 `13e63ca8-8790-41e6-b40d-88e791455c3e` | 엔진 변경 후 검색과 여행 답변, 환승 오류·중국어 표현 |
| 첨부 `d2628907-f4c0-4f02-855f-eb3987800d9a` | `hermes-extract-test.py` 직접/검색 후 추출의 두 PASS와 모델에 전달된 본문 |
| 별도 전달한 이미지/추출 실습 소스 | plugin/provider, 검사기 해석 방식, 입력/네트워크/본문 제한, 설치·rollback의 범위 |

첨부 식별자는 대화 원본을 추적하기 위한 것이며 저장소 안의 파일 경로가 아니다. 키·개인 정보가 포함될 수 있는 로그 전체를 그대로 복사하지 않고 필요한 관측값을 이 문서에 기록했다.

현재 리소스를 다시 확인할 때는 **master**에서 아래 조회를 실행한다. 아래 명령을 이번 문서 작성 중 실행한 것은 아니다.

```sh
sudo k3s kubectl -n mori get deployment,svc,pods -o wide
sudo k3s kubectl -n mori get pvc mori-hermes-shared-home
sudo k3s kubectl -n mori-tools get deployment,svc,pods -o wide
sudo k3s kubectl -n mori-tools top pods --containers
```

검사 위치를 잊지 않도록 기존 호출을 남긴다. **다음 명령은 외부 검색과 GPU 추론을 실제 실행하며, 이미 통과한 시험을 지금 모두 반복하라는 지시가 아니다.** 아래는 과거 명령 기록이며 삭제된 환경에 실행하지 않는다. 재배포 후에는 `master`의 `scripts/smoke/runtime.py`를 사용한다.

```sh
cd /home/dongyeop/mori-searxng-lab-20260928
python3 inspect-hermes.py
python3 search-test.py "국립중앙박물관"
python3 hermes-web-test.py

cd /home/dongyeop/mori-image-lab-20260928
python3 direct-test.py
python3 hermes-image-test.py

cd /home/dongyeop/mori-extract-lab-20260928
python3 hermes-extract-test.py
python3 hermes-extract-test.py --search
```

일반 검색은 최신 언어/엔진 설정, 이미지 검사는 직접 호출과 간접 호출 지원, 추출 검사는 호출 순서와 본문 길이·출처를 같이 확인한다. 모델 답변만 복사하면 실제 도구 사용과 실패 원인을 나중에 재구성하기 어렵다.

## 11. 시험 이후 정리와 소스 관리 전환

사용자가 제공한 후속 조회에서 Hermes Deployment·Service·ConfigMap·Secret·PVC와 SearXNG Deployment·Service·ConfigMap·Secret은 `--ignore-not-found` 조회에 남지 않았고, 두 Pod selector도 `No resources found`였다. 전체 PV 목록에도 기존 Hermes PV가 없었다. 다른 서비스의 PV는 Bound로 남아 있었다. 이 근거로 위에 기록한 실습 workload와 home의 삭제를 확인했다. namespace 자체와 호스트의 실습 파일 삭제를 증명하는 출력은 아니다.

코드는 `master` `7a19b61`(API), `2e2a397`(이미지·YAML·CLI), `8fe2f85`(배포 안내)에 저장했다. 로컬 검증은 백엔드 157개, 런타임 33개 및 고정 base의 amd64 기동 검사까지다. 실제 신규 이미지의 GPU 추론·외부 검색·Mori API 통합 결과는 아직 없다. 이전 실험 PASS와 새 배포 인수 PASS를 혼동하지 않는다.
