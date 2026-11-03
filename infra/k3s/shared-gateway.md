# Free 사용자용 공유 Hermes 게이트웨이

Free 사용자는 `shared-gateway.yaml`의 **하나의 Deployment/Pod**를 사용한다. Mori API가 소셜 인증·사용 권한을 확인하고 서버 측 사용자 UUID를 전달한다. 게이트웨이는 UUID마다 별도 Hermes 프로세스, HOME·HERMES_HOME, 임시 디렉터리, 설정, 세션·메모리 디렉터리와 임의 API 키를 만든다. 사용자 식별자를 프롬프트에 넣는 것만으로 분리하지 않는다. Pro의 개인 Knative 런타임은 [runtime-provisioning.md](runtime-provisioning.md)를 따른다.

## 요청과 격리 경계

내부 Service는 `http://mori-hermes-shared-gateway.mori.svc.cluster.local:8642`다. `/health` 이외의 요청에는 서버 전용 `Authorization: Bearer <shared-key>`와 소문자·하이픈을 포함한 정규 UUID 형식의 `X-Mori-User-ID`가 필요하다. 중복 인증·사용자 헤더도 거부한다. 브라우저나 앱에 공유 키를 전달하지 않는다. NetworkPolicy는 같은 namespace의 `app: mori-api`, `app: mori-worker`만 포트 8642에 접근하도록 제한한다. 이 정책은 NetworkPolicy를 적용하는 CNI가 필요하다.

허용하는 런타임 API는 `GET /v1/toolsets`와 `POST /v1/responses` 두 개다. 요청 쿼리를 허용하지 않는다. 응답 요청은 `input`, `instructions`, `conversation_history`, `store=false`, `stream=true`만 받는다. 과거 대화의 role은 `user`/`assistant`만 받으며 도구 호출, 프로필·세션 선택, 이전 응답 ID, 모델·도구·설정 재정의를 받지 않는다. Mori 서버는 해당 사용자 소유 대화·문맥을 조회한 뒤 이 요청을 구성해야 한다.

자식 프로세스는 `127.0.0.1`의 임의 포트에서만 수신하고 각자 다른 키로 인증한다. 상위 공유 키와 원래 요청의 헤더·쿠키·세션 ID는 자식에게 전달하지 않는다. 공식 main-wrapper는 HOME을 `/opt/data`로 고정하므로 **부모 게이트웨이에만** 사용한다. 자식은 `/opt/hermes/.venv/bin/hermes gateway run`을 직접 실행해 사용자별 HOME을 유지한다. 부모와 자식은 공식 stage2 초기화와 s6 권한 하강 이후 UID 10000으로 실행한다.

공유 템플릿에서는 `providers`, `model`, `web`만 복사하고 API 채널·플러그인·도구 목록을 서버가 고정한다. `web_search`, `web_extract`, `mori_image_search`만 활성화한다. 파일·터미널·문서 실행 도구, MCP 서버, 임의 hook과 다른 채널 설정을 복사하지 않는다. 프로필 `.env`/`.op.env`, 외부 경로 symlink, 이미지 소유의 두 플러그인 외 플러그인은 거부한다. 실제 도구 목록을 시작할 때와 `/v1/toolsets` 응답마다 검증한다.

upstream이 자식 환경을 덮어쓸 수 있는 `/opt/hermes/.env`, `/etc/hermes/.env`, `/etc/hermes/config.yaml`이 있으면 이미지 빌드·공유 모드 시작을 실패시킨다. `/etc/hermes/image-provenance.json`은 허용한다. 자식 PATH에는 이미지의 고정 실행 경로만 넣고 `/opt/data/.local/bin`을 상속하지 않는다. 런타임 의존성 자동 설치를 끄고 쓰기 허용 루트·설치 대상도 해당 프로필 아래로 고정한다.

이 구조는 **같은 Unix UID 안의 논리적 프로필 분리**다. 커널·컨테이너·사용자 UID별 보안 샌드박스가 아니며, 임의 코드 실행이나 플러그인 침해에 대한 격리를 제공하지 않는다. 검색 전용 도구 정책을 유지해야 한다. 임의 코드·터미널·파일 접근을 Free 런타임에 추가하려면 별도의 OS 격리 설계가 필요하다.

## 수명과 용량

| 설정 | 기본값 | 동작 |
| --- | --- | --- |
| `MORI_SHARED_MAX_PROCESSES` | 4 | 동시에 살아 있는 사용자별 자식 수 |
| `MORI_SHARED_IDLE_SECONDS` | 180 | 사용하지 않는 자식 회수 기준 |
| `MORI_SHARED_MAX_PROFILES` | 40 | PVC에 남아 있는 사용자 프로필 수 상한 |
| `MORI_SHARED_PROFILE_MAX_BYTES` | 100000000 | 프로필별 기록량 검사 기준 |
| `MORI_SHARED_HOME_ROOT` | `/opt/data/tenants` | UUID별 영속 프로필 루트 |
| `MORI_SHARED_CONFIG` | `/bootstrap/config.yaml` | 읽기 전용 운영 템플릿 |

프로세스가 가득 차면 가장 오래 사용하지 않은 비활성 자식을 종료한다. 스트리밍 중이거나 같은 사용자 요청을 기다리는 자식은 용량 확보를 위해 종료하지 않는다. 모두 사용 중이면 `503 SHARED_CAPACITY`를 반환한다. 같은 사용자의 요청은 직렬화한다. 실행 중인 SSE 클라이언트가 연결을 끊거나 응답이 잘못되면 해당 자식을 종료하고 잔여 추출 프로세스도 정리한 뒤 실행 잠금을 해제한다. 아직 실행 잠금을 기다리던 요청의 취소는 현재 실행을 종료하지 않는다. 무효화한 자식을 정리 전에 다음 요청이 재사용하지 못한다. 시작 실패는 해당 프로세스를 제거하며 다음 요청이 다시 시작한다.

기록량은 요청을 받기 전과 살아 있는 프로필에 대해 10초마다 검사한다. 파일·디렉터리 수도 20,000개로 제한한다. 한도를 초과하면 새 요청을 거부하고 해당 자식을 종료한다. 이는 **애플리케이션 수준의 검사이며 검사 사이의 일시적 초과를 막는 파일시스템 hard quota는 아니다**. 5Gi PVC 요청도 local-path에서 물리적 디스크 hard quota를 보장하지 않는다. 운영 저장소의 실제 용량·경보를 별도로 설정한다.

유휴 회수와 Pod 재시작은 사용자 프로필 파일을 삭제하지 않는다. 프로필 수 또는 기록량 초과 상태는 `503 PROFILE_CAPACITY`/`PROFILE_QUOTA`로 반환한다. 계정 삭제·보존 기한 정리는 별도 운영 절차이며 자동으로 다른 사용자의 프로필을 지우지 않는다. 오래된 프로필을 삭제하려면 소유자·보존 정책을 확인하고 해당 사용자 실행을 중단한 상태에서 처리한다.

## 배포 준비

현재 파일은 로컬 구현·검증 대상이다. 아래 절차는 운영자가 실제 배포할 때 실행하며, 이 변경에서 배포·Secret 생성·이미지 push는 수행하지 않았다.

1. `hermes/Dockerfile`로 이미지를 다시 빌드하고 실제 digest를 `shared-gateway.yaml`의 이미지에 넣는다. 기존 `mori-hermes:dev`나 과거 단일 사용자 이미지로 배포하지 않는다. private registry이면 `imagePullSecrets`도 설정한다.
2. `mori` namespace, `local-path` StorageClass와 `k3s-infra` 배치를 확인한다. `replicas: 1`, `Recreate`, 전용 PVC를 유지한다. 이전 단일 사용자 `/opt/data` PVC를 공유 프로필 PVC로 재활용하지 않는다.
3. 운영 설정을 반영한 `infra/k3s/base/hermes/config.yaml`로 `mori-hermes-config` ConfigMap을 준비한다. 기본 모델/GPU 주소를 실제 환경과 맞춘다. `mori-hermes` Secret에는 `LLAMA_API_KEY`가 필요하며 `SEARXNG_URL`은 기존 공용 검색 Service를 가리킨다.
4. 안전한 난수 생성기로 최소 32자의 서버 전용 키를 만든다. `mori-hermes-shared-gateway` Secret의 `MORI_SHARED_GATEWAY_KEY`와 API/worker의 `MORI_SHARED_HERMES_API_KEY`에 같은 값을 저장한다. Git·명령 기록·프론트 설정에 키를 남기지 않는다.
5. API와 worker의 `mori-backend` Secret에 다음 서버 설정을 추가한다. 양쪽 모두 같은 공유 라우팅 설정을 사용해야 한다.

```dotenv
MORI_SHARED_HERMES_ENABLED=true
MORI_SHARED_HERMES_BASE_URL=http://mori-hermes-shared-gateway.mori.svc.cluster.local:8642
MORI_SHARED_HERMES_API_KEY=<위에서 만든 서버 전용 키>
```

6. 변경 승인 후 `kubectl apply -f infra/k3s/shared-gateway.yaml`로 PVC·Deployment·Service·NetworkPolicy를 적용한다. 부모 `/health`는 게이트웨이 생존만 확인한다. 실제 사용자 자식은 첫 `/v1/toolsets` 요청 때 기동하므로 GPU·검색 준비까지 보장하는 probe가 아니다.
7. 두 테스트 사용자로 Mori API를 통해 각자 요청하고, 서로 다른 프로필·PID·자식 키·대화가 사용되는지 검증한다. Pod를 재시작해 프로필 보존과 키 재생성을 확인한다. 직접 런타임 API에는 서버 관리자만 접근한다.

## 검증 범위

`hermes/tests/test_shared_gateway.py`는 로컬 HTTP 서버와 실제 OS 자식 프로세스로 인증·라우팅·환경·메모리 파일 분리, 도구 정책, 재시도, SSE 사용 중 회수 방지·연결 종료, 유휴 회수, 프로필 수·기록량 제한을 검사한다. 이미지 entrypoint의 stage2/권한 하강 경로는 소스 계약을 확인한다. Docker daemon을 사용할 수 없는 환경에서 작성했으므로 **새 공유 이미지의 실제 기동, UID·신호 전달, Kubernetes/CNI, GPU 모델 호출은 아직 통합 검증하지 않았다**. 배포 전 새 이미지로 이 검증을 수행해야 한다.

기존 [단일 사용자 이미지 검사](../../scripts/runtime/check_image.py)는 기본 실행 모드의 회귀 검사다. 공유 모드를 검증했다는 증거로 대신 사용하지 않는다. 고정 upstream을 바꾸면 HOME·dotenv·플러그인 로딩과 loopback API 설정을 다시 검토한다.
