# k3s의 공용 Hermes Gateway 콜드 스타트 — 설치·전환 절차

[전체 계획](../plan.md) · [아키텍처](plan.md)

갱신일: 2026-09-21 · 상태: **Knative 기반 설치·테스트 앱의 1→0→1 확인, 실제 Hermes 전환은 미완료.** 사용자가 서버에서 실행한 출력에 근거하며 직접 원격 점검한 결과는 아니다. [검증 기록](knative-validation-2026-09-21.md).

재현 가능한 설치 설정은 **[노드별 실습 가이드와 Kustomize 파일](knative-lab/README.md)**에 있다. master에서 명령을 실행하고 workload는 worker에 배치하며, master UFW는 비활성 유지·worker UFW만 보완한다. 이미 설치된 클러스터에서는 설치를 반복하지 않고 3절의 실제 Hermes 준비·전환으로 진행한다.

## 적용 범위와 위치

- 미니 PC 1의 **k3s master/server에서 `sudo k3s kubectl`로 클러스터 전체에 Knative Serving을 설치**한다. 설치 명령을 master에서 실행한다고 모든 Pod가 master에서만 실행되는 것은 아니다.
- 노트북 1의 k3s CPU worker에 공용 Hermes Gateway Pod를 배치한다. Pod는 HTTP 요청이 없으면 0개, 필요하면 최대 1개로 기동한다.
- Mori API·PostgreSQL·예약/작업 Worker는 요청을 받을 수 있도록 계속 가동한다. Linux RTX 3090 eGPU 노트북의 llama.cpp `192.168.0.8:8080`도 k3s 밖에서 계속 가동한다. llama.cpp의 API 키는 k3s Secret으로 Hermes에만 제공한다.
- Knative Serving의 controller, autoscaler, activator와 네트워크 구성요소는 설치 후 상시 자원을 사용한다. 절감 대상은 공용 Hermes 프로세스의 유휴 CPU·메모리다. Eventing은 HTTP 콜드 스타트에 필요하지 않다.
- 이 절차는 **공용 Gateway P1 실험**이다. 유료 사용자별 Pod, 예약 사전 준비, 사용자 격리와 긴 비동기 작업의 수명주기는 [아키텍처](plan.md#유휴-중지와-콜드-스타트)의 별도 설계다.

## 1. 설치 전 확인

미니 PC 1에서 실행한다.

```bash
sudo k3s kubectl version
sudo k3s kubectl get nodes -o wide
sudo k3s kubectl get svc -A
sudo k3s kubectl get pods -A
sudo k3s kubectl -n mori get deploy,svc,pvc
```

2026-09-20 기준 지원 중인 Knative Serving `v1.23.0`의 **최소 Kubernetes 버전은 1.34**다. `kubectl` 클라이언트 버전만 보지 말고 `get nodes`의 server/worker Kubernetes 버전과 실제 API 서버 버전을 확인한다. 미달이면 k3s server와 worker 업그레이드·백업 계획을 먼저 세우고, 업그레이드 후 호환성을 다시 확인한다. 노트북 worker의 CPU·RAM·디스크와 상시 전원/절전 상태도 확인한다. [Knative 릴리스 표](https://github.com/knative/community/blob/main/mechanics/RELEASE-SCHEDULE.md), [설치 선행 조건](https://knative.dev/docs/install/yaml-install/serving/install-serving-with-yaml/).

k3s 기본 Traefik/ServiceLB가 이미 노드의 80/443 포트를 사용한다면, Kourier의 기본 `LoadBalancer` Service를 그대로 설치해 같은 포트를 점유시키지 않는다. 공용 Hermes는 클러스터 내부에서만 호출할 것이므로 **Kourier 설치 매니페스트의 gateway Service를 `ClusterIP`로 바꾼 뒤 적용**하는 안을 우선 검토한다. 기존 Traefik을 중단하거나 인터넷에 Hermes를 공개할 필요는 없다. Kourier 리소스 이름·포트·타입은 내려받은 해당 버전 매니페스트에서 확인하고, 변경본을 운영 설정으로 보관한다. [k3s 네트워킹](https://docs.k3s.io/networking/networking-services), [Kourier 구성](https://github.com/knative-extensions/net-kourier).

## 2. Knative Serving 설치 — 완료된 기반과 재현 방법

2026-09-21 Serving/Kourier 1.23.0을 설치했고 시스템 Pod 6개가 `k3s-infra`에서 Ready임을 확인했다. `kourier`와 `kourier-internal`은 모두 ClusterIP다. 설치 파일은 [knative-lab](knative-lab/README.md)에 보관한다.

재설치가 필요하면 해당 가이드대로 공식 CRD → worker 배치·toleration을 반영한 Serving → ClusterIP로 수정한 Kourier 순서로 적용한다. 원본 core/Kourier 매니페스트를 직접 적용하면 현재 배치·Service·HPA 설정이 덮어써질 수 있으므로 저장된 Kustomize 설정에서 생성한 파일을 사용한다. master에 임시로 복사한 파일은 삭제 가능하고 Git의 원본에서 다시 생성할 수 있다.

설치만으로 기존 Hermes Deployment가 Knative Service로 바뀌지는 않는다. 아래는 아직 실행하지 않은 실제 Hermes 전환 절차다.

## 3. 기존 Hermes 매니페스트를 Knative Service로 전환

`master/infra/k3s/hermes-shared.yaml`은 현재 **일반 Deployment `replicas: 1` + ClusterIP Service + `local-path` PVC** 예시다. 그대로 적용하면 상시 실행된다. 또한 현재 worker에는 초안의 `mori-agent=true` 라벨이 없고 `infra=true:NoSchedule` taint가 있으므로 배치 설정부터 보완해야 한다. 이 파일을 바로 Knative Service라고 간주하지 않는다.

1. 기존 Gateway의 단일 요청과 `192.168.0.8:8080/v1` 연결을 먼저 검증한다. `/v1/models`의 실제 모델 ID로 `REPLACE_MODEL_ID`를 교체하고 API 키를 Secret에 넣는다. 이미지와 볼륨 백업·복구 방법도 확인한다.
2. Knative Service는 예를 들어 `mori-hermes-knative`라는 **새 이름**으로 작성한다. 기존 Kubernetes Service `mori-hermes-shared`와 이름을 충돌시키지 않는다. `namespace: mori`, `networking.knative.dev/visibility: cluster-local`, KPA, `min-scale: "0"`, `max-scale: "1"`, `scale-down-delay: "10m"`를 사용한다. `containerPort: 8642`, `API_SERVER_HOST=0.0.0.0`, readiness 경로와 Secret 연결을 실제 Hermes 이미지에서 확인한다. [내부 Service](https://knative.dev/docs/serving/services/private-services/), [확장 범위와 지연](https://knative.dev/docs/serving/autoscaling/scale-bounds/).
3. worker 선택은 실습과 같은 `kubernetes.io/hostname: k3s-infra`를 사용하거나 전용 라벨을 명시적으로 관리한다. `infra=true:NoSchedule` toleration도 지정한다. nodeSelector·tolerations, `initContainers`, `fsGroup`, PVC 쓰기를 Knative Service에 옮길 경우 `knative-serving/config-features`에서 `kubernetes.podspec-nodeselector`, `kubernetes.podspec-tolerations`, `kubernetes.podspec-init-containers`, `kubernetes.podspec-securitycontext`, `kubernetes.podspec-persistent-volume-claim`, `kubernetes.podspec-persistent-volume-write`를 허용해야 한다. 실습에서 nodeSelector/tolerations는 이미 허용했으므로 나머지 필요한 플래그를 추가한다. 실제 매니페스트의 필드만 허용하고 적용 전에 admission 오류를 확인한다. [Serving 기능 플래그](https://knative.dev/docs/serving/configuration/feature-flags/), [PVC 지원](https://knative.dev/docs/serving/services/storage/).
4. 기존 Deployment를 0개로 줄이고 **기존 Pod 종료와 home 기록 완료를 확인한 다음** 같은 PVC를 새 Knative Revision에 연결한다. `ReadWriteOnce`와 `max-scale: 1`만으로 기존 Deployment나 서로 다른 Revision의 동시 작성을 막을 수 없다. 새 Revision 배포 때도 old/new가 같은 home을 동시에 쓰지 않도록 유지보수 절차와 종료 확인이 필요하다. 초기 `local-path` PVC는 해당 worker에 묶이므로 다른 노드로 자동 이전된다고 가정하지 않는다.
5. Mori Adapter의 Hermes 목적지를 기존 Service에서 `sudo k3s kubectl -n mori get ksvc mori-hermes-knative`에 표시되는 **클러스터 내부 Knative Route**로 바꾼다. Gateway 인증은 계속 적용한다. Knative Pod IP나 예전 Service로 직접 보내면 0개에서 깨우지 못한다. 실패 시 새 Route로 보내기를 중지하고 새 Pod 종료를 확인한 뒤 기존 Deployment를 1개로 복구한다.

Knative는 **HTTP 트래픽**으로 확장한다. 빠른 `202 Accepted` 뒤에 Pod 안에서 오래 계속되는 작업, 예약 시각의 자체 타이머, 승인 대기, 장기 파일 작업을 Knative만으로 보호할 수 없다. 첫 검증은 HTTP 연결이 완료까지 유지되는 짧은 대화 요청으로 제한한다. 이후 DB에 저장된 작업과 실제 Pod 처리의 생명주기를 연결하고, 비동기 작업이 축소 전에 완료되거나 안전하게 재개됨을 확인한다. KPA의 유휴 10분은 이 검증을 대신하지 않는다. [Knative 요청 경로](https://knative.dev/docs/serving/request-flow/).

## 4. 인수 확인

```bash
sudo k3s kubectl -n mori get ksvc,revision,pods
sudo k3s kubectl -n mori get ksvc mori-hermes-knative
```

- Mori Adapter를 통한 인증된 짧은 대화 요청으로 Pod **0→1** 기동, 응답, llama.cpp 호출을 확인한다. 클러스터 내부 Route가 사용됐는지 확인한다.
- 요청이 끝난 뒤 Pod **1→0**을 관찰한다. `scale-down-delay: 10m`는 즉시 종료 시각을 보장하는 값이 아니므로 실제 시간을 기록한다.
- 0개 상태에서 다시 요청해 세션/home·기억이 보존되는지 확인한다. 콜드 스타트 p50/p95, 첫 토큰 시간, 실패율, PVC 재부착 시간, 유휴 전후 CPU·메모리를 기록한다.
- Mori API의 주차/일정 조회와 예약 Worker가 Hermes Pod 0개일 때도 동작하는지 확인한다. GPU 노트북이 잠들거나 `8080` 접근이 끊겼을 때 AI 작업 실패와 기존 조회 경로를 구분한다.
- 두 계정에서 profile·파일·도구 권한의 격리가 증명되기 전에는 공용 Gateway를 다중 사용자에게 열지 않는다.

Knative 기반·샘플 검증 결과는 기록됐지만 이 절의 Hermes 전환·LLM·home 보존 인수 항목은 아직 완료되지 않았다.
