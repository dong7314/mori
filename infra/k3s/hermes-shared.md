# 홈 k3s에 Hermes·SearXNG 배포

검증했던 일반 검색·이미지 후보 검색·HTML 본문 추출을 이미지와 YAML로 관리한다. 이 구성은 **일반 Deployment, 단일 운영자 개발 환경**이다. Mori API·소셜 로그인·DB·Knative 전환을 함께 배포하지 않는다.

2026-09-28 사용자가 기존 Hermes/SearXNG Deployment·Service·ConfigMap·Secret·Hermes PVC/PV 삭제를 확인했다. 아래는 빈 PVC에서 다시 시작하는 절차다. 삭제한 대화·메모리를 복구하거나 별도 백업을 요구하지 않는다. 이전 실습 ConfigMap 전체는 남아 있지 않으므로, SearXNG는 확인한 엔진 조합과 고정 릴리스의 내장 Naver parser로 재구성했다. 실제 홈 네트워크에서 검색 품질은 재확인해야 한다.

공용 SearXNG만 먼저 설치하려면 [Git 기반 검색 서비스 배포](searxng-shared.md)를 따른다. 이후 아래 Secret/YAML 생성 명령에 `--component hermes`를 넣으면 이미 설치한 SearXNG를 건드리지 않고 Hermes만 준비한다.

## 1. 파일과 실행 위치

| 대상 | 관리 위치 |
| --- | --- |
| Hermes 이미지·플러그인·추출 의존성 | `hermes/` |
| Hermes 실행 설정 | [base/hermes/config.yaml](base/hermes/config.yaml) |
| SearXNG 엔진·언어·JSON 설정 | [base/searxng/settings.yml](base/searxng/settings.yml) |
| Deployment·Service 및 ConfigMap 원본 | `base/hermes/`, `base/searxng/` |
| 홈 worker 배치 | 각 Deployment의 `nodeSelector`·`tolerations` |
| PVC | [storage/hermes-home.yaml](storage/hermes-home.yaml), 앱 YAML과 별도 적용 |
| 적용할 일반 YAML | `configure.py`가 만드는 `.local/manifests/hermes.yaml`, `.local/manifests/searxng.yaml` |
| 실행 후 검사 | [../../scripts/smoke/runtime.py](../../scripts/smoke/runtime.py) |

- **개발 PC/빌드 머신:** 코드 검증, linux/amd64 이미지 빌드·Harbor push.
- **k3s master `192.168.0.100`:** 저장소의 같은 코드 버전에서 Secret 준비, YAML 적용, 검사.
- **worker `k3s-infra`, `192.168.0.20`:** Pod 실행. 수동 패키지 설치나 YAML 복사는 하지 않는다.
- **GPU `192.168.0.8:8080`:** 기존 llama.cpp 유지. 모델을 다시 설치하지 않는다.

초기 `hermes-shared.yaml`은 제거했다. 두 컴포넌트의 원본 파일을 결합해 일반 Kubernetes YAML을 만든다. 이 파일은 ConfigMap·Deployment·Service를 포함하며 `kubectl apply -f`로 적용할 수 있다. 이번 변경은 로컬 작성·검증까지만 수행했고 홈 클러스터에는 아직 적용하지 않았다.

## 2. 배포 전 설정

Hermes 설정의 GPU 주소와 모델 alias는 기존 시험 값을 사용한다.

```text
GPU API: http://192.168.0.8:8080/v1
Model: ggml-org/Qwen3.8-27B-GGUF:Q4_K_M
Context: 98304
```

서버에서 alias/context를 변경했다면 `base/hermes/config.yaml`도 맞춘다. context 값은 운영 성능 보장치가 아니다. `gateway.multiplex_profiles: false`, `web.search_backend: searxng`, `web.extract_backend: mori-local`이며 API에는 `web`, `mori_images`만 활성화한다.

SearXNG는 일반 검색 Google/Naver/Brave, 이미지 Google/Naver만 활성화한다. DuckDuckGo/Bing·뉴스·영상·지도 경로 계산은 이번 설정에 포함하지 않는다. 검색과 사진 후보 반환은 각각 본문 전체·이미지 로딩·환승 경로 검증과 다르다.

CPU/RAM은 기존 시험의 시작값을 사용한다. Hermes requests 250m/512Mi, limits 2 CPU/4Gi; SearXNG requests 250m/512Mi, limits 1 CPU/1Gi다. 경량화 측정값은 아니며 실제 사용량을 보고 조정한다.

## 3. 이미지 빌드·Harbor 등록 — 빌드 머신

저장소 루트에서 실행한다. Harbor 주소와 프로젝트는 실제 운영 값으로 바꾼다. 아래 예시 호스트가 실제 주소라는 뜻은 아니다.

```sh
MORI_REGISTRY='harbor.example.com'
MORI_IMAGE="$MORI_REGISTRY/mori/mori-hermes:0.1.0"
docker login "$MORI_REGISTRY"
docker buildx build --platform linux/amd64 --tag "$MORI_IMAGE" --push hermes
docker buildx imagetools inspect "$MORI_IMAGE"
```

빌드 출력/inspect에서 `sha256:...` digest를 기록한다. 이후 배포에는 태그 대신 `REGISTRY/PROJECT/IMAGE@sha256:...`를 사용한다. Mac의 ARM 기본 이미지로 worker에 배포하지 않는다. 새 릴리스는 태그도 변경한다. 이 저장소에 Harbor 인증 정보를 넣지 않는다.

Hermes는 공식 digest를 base로 고정하고 이미지 안에 `/opt/mori/plugins`, `/opt/mori/extract-venv`를 포함한다. 매 시작마다 pip 설치·소스 다운로드를 하지 않는다. 공식 이미지의 entrypoint/권한 하강을 유지하며 `HERMES_GATEWAY_NO_SUPERVISE=1`로 gateway를 foreground 실행한다. 프로세스 재시작은 Kubernetes가 맡는다. 기본 s6 경로에서 권한 하강 후 `/run/service/.gateway-default.tmp` 생성이 실패한 로컬 재현을 해결하기 위한 설정이다.

SearXNG는 YAML에 고정한 공식 digest를 직접 받으므로 추가 빌드가 필요 없다. worker에서 Harbor의 TLS 인증서·레지스트리 접근이 준비돼 있어야 한다. TLS 오류를 만났다고 이미지 pull 검증을 끄지 않는다.

## 4. Namespace·Secret·저장소 준비 — master

이하 모두 **master의 저장소 루트**에서 실행한다. 이 명령은 클러스터를 변경한다.

```sh
sudo k3s kubectl apply -f infra/k3s/namespaces.yaml
python3 scripts/runtime/create_secrets.py --registry 'harbor.example.com'
sudo k3s kubectl apply -f infra/k3s/storage/hermes-home.yaml
```

Secret 생성기는 숨김 입력으로 기존 GPU API 키와 Harbor pull 전용 robot 자격증명을 받는다. Hermes API 키와 SearXNG secret은 난수로 생성한다. 값은 출력·로컬 파일 저장하지 않으며 기존 정상 Secret은 유지한다. Harbor가 public pull을 허용하면 `--registry`를 생략한다.

생성되는 Secret:

| namespace/name | 키 |
| --- | --- |
| `mori/mori-hermes` | `API_SERVER_KEY`, `LLAMA_API_KEY` |
| `search/searxng-secret` | `SEARXNG_SECRET` |
| `mori/harbor-pull` (private registry 선택 시) | Docker registry 인증 |

PVC는 5Gi `local-path`, 이름은 `mori-hermes-shared-home`이다. StorageClass가 `WaitForFirstConsumer`이면 Pod 생성 전 `Pending`일 수 있으므로 이 시점에 Bound 대기로 막지 않는다. 이 구성은 worker 하나에 고정하며 자동 노드 이동/스토리지 복구는 제공하지 않는다.

## 5. 일반 YAML 생성·검증·적용 — master

빌드한 이미지의 실제 digest를 넣는다. `...`는 교체할 자리이며 실제 값으로 사용할 수 없다.

```sh
python3 scripts/runtime/configure.py \
  --image 'harbor.example.com/mori/mori-hermes@sha256:...' \
  --pull-secret harbor-pull
```

이 명령은 `.local/manifests/hermes.yaml`과 `.local/manifests/searxng.yaml`을 생성하며 클러스터를 바꾸지 않는다. 과거 Kustomize 생성물의 경로 `.local/runtime/`과 분리했다. 각 파일은 Namespace·PVC·Secret과도 분리된다. `.local/`은 Git 제외 경로이고 비밀 값을 넣지 않는다. 공개 레지스트리를 쓰면 `--pull-secret`도 생략한다. init container와 본체의 이미지가 함께 교체된다.

```sh
python3 scripts/runtime/validate_manifests.py \
  --image 'harbor.example.com/mori/mori-hermes@sha256:...' \
  --pull-secret harbor-pull --output-dir .local/manifests
sudo k3s kubectl apply --dry-run=server -f .local/manifests/searxng.yaml
sudo k3s kubectl apply --dry-run=server -f .local/manifests/hermes.yaml
sudo k3s kubectl diff -f .local/manifests/searxng.yaml
sudo k3s kubectl diff -f .local/manifests/hermes.yaml
```

`diff`의 종료 코드 1은 변경점이 있다는 뜻이다. 변경 대상을 확인한 뒤 적용한다.

```sh
sudo k3s kubectl apply -f .local/manifests/searxng.yaml
sudo k3s kubectl apply -f .local/manifests/hermes.yaml
sudo k3s kubectl -n search rollout status deployment/searxng --timeout=300s
sudo k3s kubectl -n mori rollout status deployment/mori-hermes-shared --timeout=600s
sudo k3s kubectl -n mori get pods,pvc -o wide
sudo k3s kubectl -n search get pods,svc -o wide
```

최초 이미지 pull은 크기·회선에 따라 시간이 걸릴 수 있다. 실패하면 해당 Pod의 `describe`와 `initialize-home`/본체 로그로 구분한다. 두 Deployment 모두 `k3s-infra`에 배치되며 `infra=true:NoSchedule` taint를 허용한다. ConfigMap 이름은 고정이다. 설정 수정 후 적용할 때는 해당 Deployment를 별도로 재시작한다.

Hermes 주소는 유지하고 SearXNG는 공용 `search` namespace를 사용한다. 기존 `mori-tools` 리소스를 자동 삭제하거나 이전하지 않는다.

```text
http://mori-hermes-shared.mori.svc.cluster.local:8642
http://searxng.search.svc.cluster.local:8080
```

## 6. 실행 후 검사 — master, 프론트·포트포워딩 불필요

검사기는 Ready Hermes Pod 하나를 선택해 이미지에 포함된 검사 코드를 실행한다. 인증 키는 컨테이너 환경에서만 읽는다.

```sh
# 추론/외부 검색 없이: health, API 키 거부, 도구/provider 설정
python3 scripts/smoke/runtime.py --mode health

# 모델 추론 없이 SearXNG 직접 검색과 두 이미지 엔진
python3 scripts/smoke/runtime.py --mode search-direct
python3 scripts/smoke/runtime.py --mode images-direct --engine google
python3 scripts/smoke/runtime.py --mode images-direct --engine naver

# 실제 GPU 추론 + 도구 호출
python3 scripts/smoke/runtime.py --mode search
python3 scripts/smoke/runtime.py --mode images --engine google
python3 scripts/smoke/runtime.py --mode extract
python3 scripts/smoke/runtime.py --mode search-extract
```

한 단계씩 결과를 확인한다. 모델 검사는 최대 300초 기다리며 timeout이 원격 작업 취소를 보장하지 않으므로 곧바로 반복 요청하지 않는다. 검사기는 직접 호출·단일 `tool_call` 간접 호출·외부 데이터 태그를 지원하고 호출 ID/성공 결과/최종 출처를 대조한다. 복수 도구를 묶은 아직 미지원 bridge 형식은 자동 성공 처리하지 않는다. PASS가 답변 사실 정확성이나 사진 로딩까지 증명하지 않는다.

Mori API는 아직 별도 배포 대상이다. 이후 [검색 API](../../backend/docs/assistant-search.md) 또는 [임시 토큰](../../backend/docs/assistant-test-token.md) 경로를 연결한다.

## 7. 이후 변경·중지·롤백

- 엔진/모델/도구 설정: Git의 base config 변경 → 일반 YAML 재생성 → diff/apply → 해당 Deployment rollout restart.
- 플러그인/추출 의존성: 이미지 재빌드·새 digest → 일반 YAML 재생성 → diff/apply.
- Secret 값 변경: Secret 갱신 후 해당 Deployment rollout restart. ConfigMap 해시처럼 자동 감지되지 않는다.
- Stateful Hermes는 replicas 1과 `Recreate`를 유지한다. 같은 PVC에 두 Deployment를 동시에 붙이지 않는다.
- 이미지/설정 롤백: 이전 Git 설정과 이미지 digest로 일반 YAML을 다시 생성해 apply하고, 설정이 바뀌었으면 Deployment를 재시작한다. 사용자 데이터 스키마까지 자동 복구되는 것은 아니다.
- 앱 중지/제거: 생성된 두 YAML의 ConfigMap·Deployment·Service를 개별 관리한다. namespace·Secret·PVC는 별도 파일/절차이므로 남긴다. 기존 Kustomize 버전의 해시 ConfigMap은 참조 확인 후 개별 정리한다.

init container는 ConfigMap을 home에 적용하고 이미지의 플러그인 세 개를 symlink로 연결한다. 다른 대화·기억·사용자 플러그인은 건드리지 않는다. 예전 실습의 같은 이름 디렉터리가 남아 있으면 덮어쓰지 않고 실패한다. 이번 새 PVC 재배포에는 그 충돌이 없어야 한다.

## 8. 개발 검증과 한계

```sh
# 개발 환경: 별도 venv, Python 3.13 권장
python3 -m venv .local/runtime-venv
.local/runtime-venv/bin/pip install --require-hashes -r hermes/requirements.lock
.local/runtime-venv/bin/pip install --require-hashes -r hermes/documents-requirements.lock
.local/runtime-venv/bin/pip install ruff==0.16.8 PyYAML==6.0.3
.local/runtime-venv/bin/ruff check --config hermes/ruff.toml hermes scripts/runtime scripts/smoke
.local/runtime-venv/bin/python -m unittest discover -s hermes/tests -v
.local/runtime-venv/bin/python scripts/runtime/validate_manifests.py

docker build --platform linux/amd64 -t mori-hermes:runtime-check hermes
python3 scripts/runtime/check_image.py --image mori-hermes:runtime-check
```

컨테이너 검사는 자체 생성한 임시 volume/container만 만들고 제거한다. `--network none`에서 공식 entrypoint, 두 번의 초기화, plugin/provider 로딩과 API 인증을 확인하며 홈 GPU나 외부 검색을 호출하지 않는다. 실제 k3s 배포·Harbor push·검색 품질 확인은 위 운영 절차의 별도 결과로 기록한다.

이 이미지는 검증한 도구를 재현 가능하게 묶은 버전이다. 공식 이미지의 브라우저/음성 패키지를 제거한 최소 이미지가 아니며, 경량화 비율·콜드 스타트 시간·다중 사용자 격리를 보장하지 않는다. 다음 제품 개발은 자연어 주차 저장/조회 도구 연결이다.

## 문서 도구를 포함한 이미지

같은 Dockerfile에 Word·Excel·PDF 라이브러리와 한국어 PDF 폰트, `mori_documents` 플러그인이 포함된다. 기존 검색 toolset은 유지한다. 문서 도구의 명시적 활성화 및 `documents-direct` 검사는 [문서 작업 가이드](../../hermes/documents.md)를 따른다. 기존 검색 API는 문서 toolset을 허용하지 않으므로 문서 기능의 제품 API 연결은 별도 단계다.
