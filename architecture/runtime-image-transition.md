# 실습 환경 정리와 정식 이미지·개발 YAML 전환 기록

[전체 계획](../plan.md) · [현장 시험 기록](hermes-web-validation-2026-09-28.md) · [백엔드 구현 기록](../back/hermes-search-implementation-2026-09-28.md)

갱신일: 2026-09-28. **실습 리소스/PVC 삭제는 사용자 출력으로 확인했다. 재현 가능한 Hermes 이미지·검사 CLI와 일반 Kubernetes YAML 생성 경로를 구현했고 새 YAML의 로컬 구조·Kubernetes 1.34 스키마 검사를 통과했다. Harbor 이미지 등록·실제 digest를 이용한 서버 dry-run·홈 k3s 재배포·새 이미지의 실환경 회귀는 아직 하지 않았다.** master의 실습 디렉터리/압축 파일 삭제 완료는 별도로 확인하지 못했다.

## 1. 결정과 현재 상태

이전에는 공식 Hermes 이미지의 PVC에 플러그인·Python 가상환경을 수동 설치하고 별도 실습 패키지로 설정했다. 사용자 요청에 따라 테스트 데이터를 백업 없이 폐기하고 Git 소스로 다시 배포하는 방향으로 전환했다. 초기 문서의 “백업 후 교체” 제안은 이번 테스트 환경에 적용하지 않는다. 삭제한 대화·메모리의 복구를 전제로 하지 않으며 새 PVC에서 시작한다.

소스·의존성은 이미지, 선언적 설정은 Git YAML, 비밀 값은 Secret, 사용자 상태는 PVC/DB에 둔다. 다음부터 Pod 안의 수동 pip 설치나 실습 파일 복사 없이 같은 소스로 다시 배포하는 것이 목표다.

**배포 방식 변경(2026-09-28):** Hermes/SearXNG의 다음 배포는 Kustomize base/overlay를 사용하지 않는다. `master`의 `scripts/runtime/configure.py`를 일반 YAML 생성기로 바꿨고, `.local/manifests/hermes.yaml`과 `searxng.yaml`을 `kubectl apply -f`에 사용할 수 있도록 했다. 생성기는 실제 이미지 digest를 요구하며 Secret 값은 파일에 넣지 않는다. 아래 Kustomize 파일·검증 기록은 당시 구현 이력이며 현행 실행 지침이 아니다.

| 대상 | 구현/확인 상태 | 남은 작업 |
| --- | --- | --- |
| Mori API | 검색 Adapter·검색 전용 임시 인증, CLI·OpenAPI, 로컬 157개 테스트 | k3s API/DB 연결·실제 Hermes 통합 |
| Hermes | 공식 고정 base + 이미지 후보/본문 추출 도구·의존성·초기화·검사기, amd64 로컬 기동. 일반 YAML 생성·로컬 검증 완료 | Harbor 등록·서버 dry-run·새 PVC 배포·GPU/검색 회귀 |
| SearXNG | 공식 고정 이미지, 일반 3개·이미지 2개 엔진 설정, 로컬 설정 로딩. 일반 YAML 생성·로컬 검증 완료 | 서버 dry-run·worker 재배포·외부 검색 품질/제한 재확인 |
| 사용자 상태 | 실습 Hermes home/PVC/PV 삭제 확인, 새 5Gi PVC YAML 분리 | 일반 YAML 경로에서 PVC 적용·재시작·상태 유지 확인 |
| 실습 파일 | 필요한 플러그인/검사 소스를 master에 편입 | 호스트의 lab 디렉터리·압축 파일 삭제 완료 확인 |
| 기존 인프라 | k3s·Knative/Kourier·Harbor·DB·MinIO·GPU는 이번 정리 대상에서 제외 | 이번 작업에서 다른 서비스의 기능 회귀를 수행한 것은 아님 |

이 이미지는 검증한 도구를 재현 가능하게 묶은 버전이다. 공식 base의 브라우저·음성 의존성을 제거한 최소 이미지가 아니다. Free 공용과 Pro 개인용은 같은 이미지에 requests/limits를 달리하는 방향을 유지하지만 Pro 전용 Pod 자체는 아직 구현하지 않았다.

## 2. 코드 기준과 장비별 역할

| master 커밋 | 역할 |
| --- | --- |
| `7a19b61` | 검색 API·증거/출처·검색 전용 임시 인증·CLI·k3s 패치 |
| `2e2a397` | Hermes 이미지·도구·초기화, SearXNG·Kustomize·Secret/PVC, 검사·CI |
| `8fe2f85` | 빌드·배포·노드별 실행·검증·롤백 안내 |
| `d2584fb` | Kustomize 배포 파일 제거, 일반 YAML 생성기·검사·배포 안내 |

현재의 명령은 [master 배포 가이드](https://github.com/dong7314/mori/blob/d2584fb/infra/k3s/hermes-shared.md)에 있다. [이전 Kustomize 가이드](https://github.com/dong7314/mori/blob/8fe2f85/infra/k3s/hermes-shared.md)는 이력으로만 본다. 이미지 내부 구조는 [Hermes README](https://github.com/dong7314/mori/blob/d2584fb/hermes/README.md)에 있다. plan은 이력·인수 조건을 관리하고 실제 파일은 master에서 수정한다. poc는 이번 작업에서 변경하지 않았다.

| 위치 | 담당 작업 |
| --- | --- |
| 개발 PC/빌드 머신 | 테스트, `linux/amd64` 이미지 빌드·Harbor 등록·digest 확인 |
| k3s master `192.168.0.100` | 같은 소스 버전 준비, Secret/PVC 및 YAML 적용, rollout/검사 CLI 실행 |
| worker `k3s-infra`, `192.168.0.20` | YAML로 지정한 Hermes/SearXNG Pod 실행·local-path 상태 보관 |
| GPU `192.168.0.8:8080` | 기존 독립 llama.cpp 유지. 모델 가중치는 Hermes 이미지에 포함하지 않음 |

## 3. 삭제 확인의 근거와 범위

사용자가 실행한 조회에서 다음 리소스가 남지 않은 것을 확인했다. AI가 원격 클러스터에서 직접 삭제하거나 재조회한 것은 아니다.

| namespace | 확인한 삭제 대상 |
| --- | --- |
| `mori` | Deployment/Service `mori-hermes-shared`, ConfigMap `mori-hermes-config`, Secret `mori-hermes`, PVC `mori-hermes-shared-home` |
| `mori-tools` | Deployment/Service `searxng`, ConfigMap `searxng-config`, Secret `searxng-secret` |
| 클러스터 PV | 이전 Hermes home PV가 전체 목록에 없음 |
| Pod | `app=mori-hermes-shared`, `app=mori-searxng` 조회 모두 `No resources found` |

`mori`·`mori-tools` namespace 자체 삭제를 확인한 것은 아니다. 다른 Harbor·PostgreSQL·MinIO·Open WebUI·explain-code PV들은 Bound로 남아 있었다. 파일 시스템의 `/home/dongyeop/mori-*-lab-*`와 압축 파일 삭제는 이 kubectl 출력으로 판단할 수 없다.

최종 실습 ConfigMap 전체를 별도 export하지 않았으므로 과거의 모든 설정을 그대로 복구했다고 표시하지 않는다. 보관된 플러그인/검사 소스와 실제 성공한 엔진 조합을 기준으로 구현했으며 SearXNG Naver는 고정 릴리스의 내장 parser를 사용한다. 재배포 후 검색 품질을 다시 확인해야 한다.

## 4. 실제 생성한 파일과 실행 구조

아래 경로는 master 저장소의 당시 구현 기준이다. 제안 트리가 아니라 실제 커밋된 파일이며, Kustomize 경로는 다음 배포에 사용하지 않는다.

```text
hermes/
  Dockerfile, .dockerignore, README.md
  requirements.in, requirements.lock, ruff.toml
  bootstrap.py
  plugins/mori_images/{__init__.py,plugin.yaml}
  plugins/mori_extract/{__init__.py,plugin.yaml,worker.py}
  checks/{evidence.py,runtime.py}
  tests/{test_bootstrap.py,test_images.py,test_extract.py}
infra/k3s/
  namespaces.yaml
  base/hermes/{config.yaml,deployment.yaml,service.yaml,kustomization.yaml}
  base/searxng/{settings.yml,deployment.yaml,service.yaml,kustomization.yaml}
  overlays/home-dev/kustomization.yaml
  storage/hermes-home.yaml
  hermes-shared.md
scripts/runtime/
  configure.py, create_secrets.py, validate_manifests.py, check_image.py
scripts/smoke/runtime.py
.github/workflows/runtime.yml
```

### 이미지·home·플러그인

- Hermes base: `nousresearch/hermes-agent@sha256:d43ac4ef5c76ec063342cd1cb1c1f839ce73acffa9445bee87bbccfd39ccb808`.
- 실제 base revision label: `9a7b54accf841127bacfaab74fa1d7d982bca9fa`, Python 3.13.5.
- `/opt/mori/plugins`에 플러그인, `/opt/mori/extract-venv`에 Trafilatura 2.2.0과 버전/hash 고정 의존성을 설치한다. 사용자 home은 `/opt/data` PVC다.
- init container는 ConfigMap을 home의 config로 원자적으로 반영하고 두 플러그인을 이미지 경로로 연결한다. 다른 상태는 보존하며 같은 이름의 기존 디렉터리·잘못된 symlink를 덮어쓰지 않는다.
- init/main은 같은 digest를 사용한다. 이미지를 만들 때 설치하며 Pod 시작 때 네트워크로 패키지를 내려받지 않는다.
- 공식 entrypoint·권한 하강을 유지하고 `HERMES_GATEWAY_NO_SUPERVISE=1`로 gateway를 foreground 실행한다. Kubernetes가 재시작을 담당한다.

### 실행 중 발견해 수정한 문제

1. 공식 프로젝트의 uv `exclude-newer` 설정이 별도 추출 venv의 고정 의존성 설치에 간섭했다. `uv --no-config`로 별도 lock 설치가 공식 프로젝트 정책을 상속하지 않게 했다.
2. 기본 gateway가 권한 하강 후 s6 동적 서비스 `/run/service/.gateway-default.tmp`를 만들다 실패했다. 고정 base의 foreground 옵션을 적용하고 실제 정상 entrypoint로 health·인증·provider 로딩을 확인했다.
3. Kubernetes ConfigMap의 projected symlink를 초기화 코드가 지원하도록 하고, 목적지의 임의 symlink는 따라가지 않도록 구분했다. 초기화 두 번과 상태 보존을 검증했다.

### SearXNG와 서비스

SearXNG 이미지는 `docker.io/searxng/searxng@sha256:5286edb35782454ab8a102c5eff6b54bff745853191b46aeead95f225aa6dfb6`이며 시험한 `2026.9.25-12f8b6515` 릴리스를 고정한다. Google/Naver/Brave 일반 검색과 Google/Naver 이미지 검색만 포함한다. `ko-KR`, HTML/JSON, 내부 Service를 사용하며 limiter는 비활성이라 Valkey를 추가하지 않는다. DuckDuckGo/Bing·뉴스·영상·지도 환승 API는 이번 구성 밖이다.

내부 DNS는 기존과 같다. Hermes `mori-hermes-shared.mori.svc.cluster.local:8642`, 검색 `searxng.mori-tools.svc.cluster.local:8080`. 외부 도메인·Ingress가 필요하지 않다.

### YAML과 비밀 값

- 두 Deployment 모두 `Recreate`, worker hostname/amd64와 `infra=true:NoSchedule` toleration을 사용한다.
- 당시 구현은 ConfigMap generator 해시로 설정 변경을 Pod template에 반영했다. 일반 YAML에서는 ConfigMap·Secret 변경 후 필요한 Deployment 재시작을 명시적으로 수행한다.
- Hermes requests 250m/512Mi, limits 2 CPU/4Gi; SearXNG requests 250m/512Mi, limits 1 CPU/1Gi. 시작값이며 성능 측정 결과가 아니다.
- 5Gi RWO local-path PVC·namespace·Secret은 애플리케이션 매니페스트와 별도로 관리한다. Deployment 교체가 사용자 상태 삭제로 이어지지 않게 한다.
- Secret 생성기는 GPU/Harbor 자격증명을 숨김 입력으로 받고 Hermes/SearXNG 비밀 값을 생성한다. 유효한 기존 Secret은 유지하고 값은 출력하거나 Git에 저장하지 않는다.
- `d2584fb`부터 `configure.py`는 Harbor의 실제 `@sha256:...`를 받아 일반 YAML 두 파일을 만든다. Harbor 호스트/자격증명과 Secret 값은 임의로 정하거나 Git에 저장하지 않는다. ConfigMap의 이름은 고정이므로 설정 변경 후에는 해당 Deployment를 재시작한다.

## 5. 로컬 검증과 그 한계

| 검증 | 결과 | 증명하지 않는 것 |
| --- | --- | --- |
| 백엔드 전체 테스트 | 157 passed, 의존성 deprecation 경고 2개. 커밋 전 재실행 | Hermes는 MockTransport. 실제 GPU·k3s 통합 아님 |
| 런타임 unit/fixture | 33 passed, 커밋 전 재실행 | 실제 사이트/추론 품질·부하 보장 아님 |
| Ruff·OpenAPI·diff | lint/format·계약 동기화·공백 검사 통과 | 실환경 API 배포 아님 |
| Kustomize | kubectl 1.34.3으로 base/생성 overlay 렌더링·참조 검증 통과 | 서버 dry-run/apply·클러스터 승인 아님 |
| 일반 YAML (`d2584fb`) | ConfigMap·Deployment·Service 6개와 별도 Namespace 2개·PVC 1개를 생성·로컬 구조 검사·Kubernetes 1.34 스키마 검사. 9개 리소스 유효 | 실제 이미지 digest·Secret 존재·서버 admission·rollout은 미검증 |
| Hermes Docker | linux/amd64 빌드 통과, 정상 entrypoint 실행·두 번 초기화·health·무/오인증 401·도구/provider 확인 | `--network none`. GPU·검색/웹·Harbor 미호출 |
| SearXNG Docker | 고정 이미지에서 다섯 엔진·한국어 기본값·JSON 설정 로딩 | 실제 검색 결과·CAPTCHA 상태는 재확인 필요 |

런타임 테스트는 엔진 지정·실패 결과, DNS/리다이렉트/크기 제한, 실제 HTML parser fixture, 직접/간접 도구 호출 ID·출처 대조, 초기화·상태 보존·충돌 거부 등을 다룬다. 현재 CI 정의는 테스트·일반 YAML 생성/검사·amd64 빌드·오프라인 컨테이너 기동을 실행하도록 변경했다. CI 정의를 추가한 사실과 원격 CI 성공 결과는 별개다. Windows에서는 기존 bootstrap 전체 테스트가 POSIX 권한·symlink API 때문에 실행되지 않았고, 변경한 매니페스트 테스트 4개와 YAML 검사는 통과했다.

이미지 후보 검색은 사진을 다운로드하거나 시각적으로 확인하지 않는다. 추출기는 공개 HTTP(S) HTML만 처리하며 JS 렌더링·PDF·이미지 본문 처리를 제공하지 않는다. 검색/추출 PASS는 여행 일정·환승·모든 답변의 사실 정확성을 보장하지 않는다.

## 6. 이제 실행할 순서

1. **제품 코드 `master` — 로컬 완료:** ConfigMap·Deployment·Service 일반 YAML 생성, 별도 Namespace·Secret·PVC 적용 순서, 이미지 digest 반영, 설정 변경 시 재시작과 상태 보존 절차를 문서화했다. 구조·Kubernetes 1.34 스키마 검사를 통과했다.
2. **빌드 머신:** `master`의 검증한 버전으로 amd64 이미지를 Harbor에 push하고 digest를 기록한다. SearXNG는 공식 고정 이미지를 그대로 사용한다.
3. **k3s master:** 같은 Git 버전의 새 YAML과 Secret, 새 PVC를 준비한다. `WaitForFirstConsumer`이면 Pod 생성 전 PVC Pending은 가능하다.
4. **k3s master:** 확인한 이미지 digest로 `configure.py`를 실행해 `.local/manifests/`에 일반 YAML을 만든다. 파일별 `kubectl apply --dry-run=server -f`, `kubectl diff -f`를 거친 뒤 정해진 순서대로 `kubectl apply -f`한다. 기존 Kustomize overlay는 사용하지 않는다.
5. **k3s master:** 두 Deployment rollout과 worker 배치, Hermes 새 PVC Bound를 확인한다.
6. **k3s master:** `scripts/smoke/runtime.py`를 아래 순서로 한 번씩 실행한다.

```sh
python3 scripts/smoke/runtime.py --mode health
python3 scripts/smoke/runtime.py --mode search-direct
python3 scripts/smoke/runtime.py --mode images-direct --engine google
python3 scripts/smoke/runtime.py --mode images-direct --engine naver
python3 scripts/smoke/runtime.py --mode search
python3 scripts/smoke/runtime.py --mode images --engine google
python3 scripts/smoke/runtime.py --mode extract
python3 scripts/smoke/runtime.py --mode search-extract
```

검사 CLI는 Ready Hermes Pod 안의 이미지 검사기를 호출한다. 브라우저 페이지·로그인·공개 도메인·포트포워딩이 필요 없다. 앞의 직접 검사는 모델을 호출하지 않고 이후 모델 검사는 실제 GPU와 도구를 사용한다. timeout이 원격 작업 취소를 뜻하지 않으므로 즉시 반복하지 않는다.

이후 새 Pod 재시작 시 설정/플러그인과 필요한 home 상태가 유지되는지 확인하고 Mori API 경유 검색을 통합한다. 임시 토큰은 검색 경로에만 적용하며 시험 종료 후 비활성화·401 확인·전용 Secret/파일 제거 절차를 따른다.

## 7. 인수 기준과 다음 제품 기능

- [x] 실습 Hermes/SearXNG 리소스와 Hermes home 삭제를 사용자 출력으로 확인.
- [x] 이미지·도구·잠금 의존성·당시 Kustomize 구성·검사기를 master 소스로 관리.
- [x] 로컬 amd64 빌드·기동·인증 및 반복 초기화, unit/당시 manifest 검증.
- [x] Kustomize 없이 적용할 일반 Kubernetes YAML 생성·배포 절차를 master에 구현하고 로컬 구조·스키마 검증.
- [ ] Harbor에 실제 이미지 등록 및 배포 digest 확정.
- [ ] 새 PVC와 일반 Kubernetes YAML로 worker 재배포, 서버 dry-run·rollout 확인.
- [ ] 새 이미지의 GPU·일반/이미지 검색·본문·검색→추출 및 재시작 회귀.
- [ ] Mori API·DB 준비와 실제 API-to-Hermes 검색, 인증 거부/시험 모드 종료 확인.
- [ ] master 실습 폴더/압축 파일 정리 완료 확인.

그다음 제품 인수 기준은 “지하 2층 C구역 C36에 주차했어” → 실제 사용자별 Mori DB 저장 → 이후 자연어 조회다. 기존 주차 서비스의 소유권·멱등성을 재사용한다. 사용자 격리, 예약·알림, 파일 생성·OS 위젯, Pro 전용 runtime은 별도 기능이다. 실제 Hermes Knative 전환도 상태 보존·단일 작성자·작업 중 종료 방지를 검증하는 후속 작업이며 샘플 콜드 스타트 실험을 완료 근거로 삼지 않는다.
