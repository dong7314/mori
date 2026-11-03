# 사용자별 Hermes 자동 배정

관리자 승인 또는 유효한 결제 기간이 있으면 별도 provisioner가
유효 등급을 계산해 변경을 조회한다. 만료된 구독은 저장된 tier 값만으로 허용하지 않는다. 이벤트 전달에 실패해도 다음 조회가 복구하며, 같은 사용자에
대한 생성 요청은 DB 고유 키와 Kubernetes 객체 이름으로 합쳐진다.

기존 `MORI_CHAT_PRIVATE_RUNTIMES` 수동 배정은 자동 교체하지 않는다. 이 계정의
상태는 `source=operator_assigned`, `status=configured`이며 실제 연결 성공을 의미하지
않는다. 관리형 배정으로 옮기려면 기존 작업을 정리하고 데이터 이전 여부를 결정한 뒤
수동 매핑을 제거한다. 자동 배정이 기존 개인 홈의 내용을 복사하지는 않는다.

생성 대상은 `mori-agents` 네임스페이스의 사용자별 Secret, PVC, ConfigMap,
Knative Service다. 서비스는 cluster-local, min-scale 0, max-scale 1,
containerConcurrency 1이다. API는 Kubernetes 권한을 받지 않는다.

## 서버 설정

API, 작업 worker, provisioner에 동일한 `MORI_RUNTIME_MASTER_KEY`를 설정한다.
Fernet 키는 서버에서 한 번 생성하여 Secret에 보관한다. 변경 시 기존 DB의
암호화된 런타임 키를 재암호화해야 하므로 값을 임의로 교체하면 안 된다.
사용자별 API 키는 암호화해 DB에 보관하고, 해당 사용자 전용 Kubernetes Secret에만
배포한다. API 응답·상태 API·로그에는 키나 내부 Route를 포함하지 않는다.

```dotenv
MORI_RUNTIME_PROVISIONING_ENABLED=true
MORI_RUNTIME_NAMESPACE=mori-agents
MORI_RUNTIME_IMAGE=harbor.example/mori/mori-hermes@sha256:<게시한 이미지 digest>
MORI_RUNTIME_MASTER_KEY=<서버 전용 Fernet 키>
MORI_RUNTIME_LLM_URL=http://<GPU 서버>:8080/v1
MORI_RUNTIME_LLM_MODEL=<모델 이름>
MORI_RUNTIME_PROVIDER_SECRET=mori-hermes-provider
MORI_RUNTIME_STORAGE_CLASS=local-path
MORI_RUNTIME_STORAGE_SIZE=5Gi
MORI_RUNTIME_IMAGE_PULL_SECRETS=["harbor-pull"]
MORI_RUNTIME_NODE_SELECTOR={"kubernetes.io/arch":"amd64"}
MORI_RUNTIME_TOLERATIONS=[]
MORI_RUNTIME_SEARXNG_URL=http://searxng.search.svc.cluster.local:8080
MORI_RUNTIME_SCALE_DOWN_DELAY_SECONDS=120
```

위 예시의 주소·모델·digest를 실제 서버 값으로 바꾼다. 기본 모드에서는
`MORI_RUNTIME_PROVISIONING_ENABLED=false`라 Kubernetes 호출을 하지 않는다.
provisioner는 클러스터의 projected ServiceAccount 토큰과 CA를 읽으며 토큰 회전을
반영한다. API는 이를 읽거나 마운트하지 않는다.

## 배포 순서

1. backend 마이그레이션을 적용한다. 기존 API/worker와 같은 DB를 사용한다.
2. `runtime-provisioner.yaml`의 backend 이미지를 게시한 digest로 지정한다.
   Namespace와 ServiceAccount/RBAC 리소스를 먼저 적용한다.
3. `mori-agents`에 `mori-hermes-provider` Secret을 만들고 `LLAMA_API_KEY`를 넣는다.
   Harbor pull Secret도 이 네임스페이스에 만든다. 실제 값은 Git에 넣지 않는다.
4. Knative의 init-containers, securitycontext, nodeselector, tolerations,
   persistent-volume-claim, persistent-volume-write 기능 플래그를 확인한다.
   [기존 설치 절차](hermes-knative.md)의 서버 dry-run 절차를 따른다.
5. API/worker 설정과 provisioner Deployment를 적용하고
   `runtime-network-policy.yaml`을 적용한다. CNI가 NetworkPolicy를 실제 강제하는지
   확인한다. 이 정책은 직접적인 사용자 간 Pod 접근을 차단하는 ingress 정책이며,
   웹 검색·본문 추출·운영자가 지정한 모델 서버 접근을 위한 egress는 제한하지 않는다.
6. 테스트 사용자에게 Pro를 승인한 뒤 `GET /v1/me/runtime` 상태가 `ready`가 되는지
   확인한다. 준비 중에는 채팅을 받더라도 실행 경로가 준비 실패 상태를 반환한다.

상태 API의 `ready`는 Knative 서비스가 요청을 받을 준비가 된 상태다. 항상 Pod가
실행 중이라는 의미는 아니다. scale-to-zero 상태에서도 `ready`를 유지하고 다음
인증 요청으로 다시 기동한다. 사전 기동은 Mori 예약 worker가 담당하며 Hermes
native cron에 예약을 중복 등록하지 않는다.

## 회수와 재승인

Pro 회수 즉시 API의 DB 등급 검사로 개인 Route 사용이 차단된다. 진행 중인 Kubernetes 생성 요청과 정리가 충돌하지 않도록 기존 실행 lease의 만료를 기다린다. 중단 완료 후에도 5분마다 늦게 도착한 생성 요청의 리소스가 남아 있는지 확인해 정리한다. 정리 중 재승인되면 해당 정리 작업이 끝난 뒤 재배정한다. provisioner는
Service를 foreground 삭제하고 기존 Pod가 모두 사라진 것을 확인한 뒤 사용자별
Secret과 ConfigMap을 삭제한다. PVC는 기본적으로 보존한다. 데이터 삭제는 별도의
보관·파기 정책으로 운영자가 수행해야 하며 구독 취소를 데이터 삭제로 해석하지 않는다.

회수 중 재승인되어도 기존 Pod 종료가 먼저 완료된다. 다음 배정에서 새 API 키를
만들고 기존 사용자 PVC를 재사용한다. 다른 사용자의 label 또는 다른 런타임 ID가
붙은 객체는 덮어쓰거나 삭제하지 않고 `RUNTIME_RESOURCE_CONFLICT`로 실패한다.

API 키·이미지·ConfigMap을 실행 중에 바꿔 새 Knative Revision을 만드는 자동
업그레이드는 하지 않는다. RWO 볼륨에 기존/신규 Revision이 동시에 쓰는 것을
방지하기 위해 설정 변경은 `RUNTIME_CONFIGURATION_CHANGED`로 표시한다. 변경하려면
작업을 끝내고 접근을 회수하여 Pod 종료를 확인한 다음 새 설정으로 다시 배정한다.

## 확인 범위

`test_runtimes.py`는 PostgreSQL과 Kubernetes HTTP 대체 서버로 중복 생성,
사용자 격리, readiness generation, 재시도, 권한 회수, Pod drain, 재승인 키 회전,
상태 응답의 비밀값 제외를 검증한다. 실제 클러스터 적용, 이미지 pull, PVC scheduling,
Knative cold start, CNI 격리, GPU 연결은 운영 서버에서 별도로 확인해야 한다.

참고: [Knative scale bounds](https://knative.dev/docs/serving/autoscaling/scale-bounds/),
[private Services](https://knative.dev/docs/serving/services/private-services/),
[Kubernetes RBAC](https://kubernetes.io/docs/reference/access-authn-authz/rbac/),
[Knative networking ports](https://pkg.go.dev/knative.dev/serving/pkg/networking).
