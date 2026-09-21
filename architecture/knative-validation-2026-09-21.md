# 2026-09-21 k3s Knative 설치·콜드 스타트 검증 기록

[전체 계획](../plan.md) · [아키텍처](plan.md) · [재현 가이드](knative-lab/README.md) · [Hermes 전환](knative-serving.md)

상태: **Knative Serving/Kourier 설치 및 테스트 앱의 1→0→1 전환 확인. 실제 Hermes 연동은 미완료.** 근거는 사용자가 서버에서 실행해 대화에 제공한 출력이다. AI가 클러스터에 직접 접속하거나 운영 설정 전체를 덤프한 결과는 아니다.

## 1. 확인한 노드와 배치

| 항목 | master | worker |
| --- | --- | --- |
| 노드 이름 | `k3s-server` | `k3s-infra` |
| 내부 IP | `192.168.0.100` | `192.168.0.20` |
| Kubernetes | `v1.34.3+k3s1` | `v1.34.3+k3s1` |
| CPU 용량 | 4코어 | 12코어 |
| 메모리 용량 | 약 15.4GiB | 약 23.3GiB |
| Pod CIDR | `10.42.0.0/24` | `10.42.1.0/24` |
| taint | 없음 | `infra=true:NoSchedule` |
| UFW | 비활성, 활성화하지 않음 | 활성, 기본 incoming/routed deny |
| 역할 | 설치 명령 실행, 테스트 요청용 Pod 배치 설정 | Knative·Kourier와 테스트 서비스 실행 |

worker에는 `kubernetes.io/hostname=k3s-infra`와 `node-role=infra` 라벨이 있다. 기존 Hermes 초안이 사용하는 `mori-agent=true` 라벨은 제공된 출력에 없다. 실제 Hermes 배포 시 nodeSelector와 toleration을 현재 노드에 맞춰야 한다.

worker의 예약 메모리는 17,024Mi(71%)이며 그중 MinIO가 16Gi를 요청한다. 실제 메모리 사용량과 스케줄러의 예약량은 다르므로 실제 사용량만 보고 새 Pod를 배치하지 않는다. MinIO requests는 이번 작업에서 변경하지 않았다.

## 2. 접속·메트릭 문제 해결

### SSH

외부 Tabby의 `Connection refused (os error 61)`가 발생했다. master에서 `192.168.0.20:22`로 SSH를 실행하자 비밀번호 인증과 worker 로그인에 성공했다. 사용자는 외부 포트포워딩의 포트 오설정을 원인으로 확인했다. SSH 서버 재설치는 하지 않았다. Harbor 접근과 외부 SSH는 서로 다른 경로다.

### metrics-server

초기 `kubectl top nodes`에서 worker만 `<unknown>`이었다. metrics-server 로그는 `https://192.168.0.20:10250/metrics/resource`에 대한 10초 timeout을 반복했다.

- worker의 `k3s-agent`는 `*:10250`에서 LISTEN 중이었다.
- worker 내부에서 curl하면 TLS 연결 후 HTTP 401을 반환했다. 이는 무인증 요청의 응답이며 메트릭 권한 검증 성공을 뜻하지 않는다.
- worker UFW에는 10250 허용 규칙이 없었다.
- master `192.168.0.100`과 master Pod 대역 `10.42.0.0/24`에서 worker TCP 10250으로 들어오는 규칙을 추가한 뒤 메트릭이 복구됐다.
- 복구 출력: worker `89m / 5344Mi / 22%`, master `204m / 10435Mi / 66%`. 최근 1분 metrics-server 로그에는 새 오류가 없었다.

### Knative용 내부 통신

이후 worker에 Pod 대역 `10.42.0.0/23`의 노드 접근과 Pod 간 라우팅, master/worker IP에서 Pod 대역으로 향하는 라우팅 허용을 안내했다. master UFW는 비활성이므로 변경하지 않는 절차로 구분했다. 상세 명령은 [재현 가이드](knative-lab/README.md#2-내부-pod-통신을-위한-ufw-설정)에 있다. 추가 규칙 적용 후의 UFW 전체 출력은 별도로 받지 않았으며, 아래 실제 설치·호출 결과로 사용한 통신 경로를 확인했다.

## 3. 설치 파일과 실제 결과

`knative-lab/`의 Kustomize 설정으로 공식 Serving/Kourier `1.23.0` 매니페스트를 가공했다. master에서 적용하고 workload는 worker에 배치하는 구성이다.

- Deployment 6개에 worker nodeSelector와 `infra=true:NoSchedule` toleration 적용.
- Kourier의 기본 LoadBalancer Service를 적용 전에 ClusterIP로 변경.
- `config-network`에 Kourier ingress class, `config-features`에 nodeSelector/tolerations 허용 설정.
- 실습용 HPA 3개의 min/max replicas를 1로 제한. 시스템 구성요소는 상시 실행하며 고가용성 설정이 아니다.
- 테스트 서비스는 cluster-local, KPA min 0 / max 1, window 60초, 추가 scale-down-delay 0초. Hermes에 제안한 idle 10분과 별개다.

사용자가 제공한 설치 결과:

| namespace | 구성요소 | 상태 | 노드 |
| --- | --- | --- | --- |
| `knative-serving` | activator, autoscaler, controller, webhook, net-kourier-controller | 모두 `1/1 Running`, 재시작 0회 | `k3s-infra` |
| `kourier-system` | 3scale-kourier-gateway | `1/1 Running`, 재시작 0회 | `k3s-infra` |
| `kourier-system` | kourier, kourier-internal Service | 모두 `ClusterIP`, 외부 IP 없음 | — |

설치 후 한 시점의 노드 사용량은 worker `98m / 5497Mi / 23%`, master `246m / 9490Mi / 60%`였다. 기존 workload 사용량도 변하므로 이 수치의 전후 차이를 Knative 자체 점유량이나 자원 절감률로 해석하지 않는다. 기존 서비스 전체의 회귀 점검 결과는 별도 수집하지 않았다.

## 4. 테스트 앱의 유휴 종료·재기동

사용자 출력에서 다음 순서를 확인했다.

1. `coldstart-demo-00001-deployment-6d9f8544f-lm6m9`가 `2/2 Running`이었다.
2. Pod AGE 110초에 `Terminating`, 약 2분 20초에 `Completed`가 관찰됐다. AGE는 Pod 생성 후 시간이며 마지막 요청 이후 경과 시간이 아니다.
3. 서비스 라벨로 다시 조회하자 `No resources found in mori-knative-test namespace.`가 나왔다. 해당 서비스 Pod가 0개라는 뜻이며 namespace 전체가 비었다는 뜻은 아니다.
4. `knative-client`에서 Knative URL로 요청하자 `Hello Mori!`를 반환했다.
5. 새 Pod `coldstart-demo-00001-deployment-6d9f8544f-k6v8n`가 `2/2 Running`, AGE 4초로 확인됐다.

```text
Hello Mori!

real    0m1.140s
user    0m0.007s
sys     0m0.010s
```

**해석:** 테스트 앱의 1→0 유휴 종료와 0→1 재기동·응답이 확인됐다. 1.140초는 sudo/kubectl exec와 요청 완료를 포함한 단일 관측값이다. Hermes 기동, PVC 복원, LLM 첫 토큰·전체 응답, 이미지 미캐시 기동, 반복 측정 p50/p95를 검증한 값이 아니다. 재기동한 두 번째 Pod가 다시 0개가 되는 출력은 별도로 받지 않았다.

## 5. 정리 절차와 보존 범위

테스트 Knative Service, 요청용 Pod, `mori-knative-test` namespace 삭제 명령을 안내했다. master의 `/home/dongyeop/mori-knative-lab.tar.gz`와 설치 디렉터리도 삭제 가능하다고 안내했다. **실제 삭제 결과 출력은 받지 않았으므로 정리 완료로 기록하지 않는다.**

Knative Serving/Kourier와 worker 내부 통신 규칙은 다음 Hermes 배포를 위해 유지한다. 서버에 복사한 압축 파일·디렉터리를 삭제해도 이미 적용된 Kubernetes 리소스는 삭제되지 않는다. 재현 가능한 원본은 이 `plan` 브랜치의 `architecture/knative-lab/`에 보관하며 공식 다운로드 파일과 rendered 출력은 Git에서 제외한다.

## 6. 다음 작업과 완료 기준

다음 목표는 **공용 Hermes가 기존 llama.cpp를 호출하고, 자연어 주차 요청을 Mori DB에 저장·조회하는 첫 흐름**이다. 하드웨어 검증을 처음부터 반복하지 않는다.

같은 날 후속 조회에서 worker requests 17,784Mi(74%)와 `mori` namespace 부재를 확인했다. 이는 위 설치 전 예약량 17,024Mi와 관측 시점이 다르다. 사용자 실행은 리소스 조회에서 멈췄고 namespace/Secret 생성·모델 ID 확인·Hermes 배포는 아직 미실행이다. 이후 추가한 SearXNG 검증 단계와 정확한 재개 명령은 [공용 Hermes 재개 절차](hermes-shared-resume.md), 검색 분리 방향은 [검색·경량화 설계](hermes-search-runtime.md)를 따른다. 이 기록의 과거 설치 수치를 덮어쓰지 않는다.

1. **Hermes 배포 준비 (`master`):** 기존 `infra/k3s/hermes-shared.yaml`의 모델 ID placeholder와 latest 이미지를 실제 설정/검증된 digest로 교체하고 현재 worker의 selector/toleration, Secret, PVC 권한을 반영한다. worker에 배치한 Pod에서 기존 `192.168.0.8:8080/v1`에 접근하고 인증된 `/v1/models`로 모델 ID를 확인한다. API 키는 채팅·Git에 넣지 않는다. 기존 `llm/llama-llm` Service의 실제 연결 대상은 아직 미확인이므로 임의로 대체하지 않는다.
2. **Hermes↔LLM 단일 요청:** 우선 일반 Deployment에서 인증된 짧은 대화 한 번을 끝까지 확인한다. 다중 사용자 개방 전까지 단일 사용자/신뢰된 시험 계정으로 제한한다. 프로세스 health 성공만으로 LLM 연결 성공을 판정하지 않는다.
3. **실제 Hermes의 Knative 전환:** 추가 PVC/initContainer/securityContext 기능 플래그와 readiness·timeout·종료·단일 home 작성자 조건을 검증하고, 내부 Route 호출로 기동·응답·유휴 종료·home 보존을 확인한다. 같은 PVC를 쓰는 기존 Deployment와 새 Revision을 동시에 실행하지 않는다.
4. **Mori Adapter와 주차 도구:** 인증된 Mori 사용자 문맥을 서버에서 주입하고 Hermes의 여러 차례 LLM/도구 호출을 허용한다. 기존 주차 서비스에 `parking.save`/`parking.latest`를 연결하고 DB의 실제 성공 후 답한다. 모델에게 받은 사용자 ID를 권한으로 사용하지 않으며 재시도 중복 저장과 다른 계정 조회 차단을 검증한다. 앱의 작업 접수/조회 계약과 영속 작업 처리는 이 통합 과정에서 구현한다.

첫 인수 예시: “지하 2층 C구역 C36에 주차했어” → Hermes 도구 호출 → 해당 계정의 PostgreSQL 기록 → “차 어디에 뒀지?”에 저장한 위치 반환. Pod 재기동 뒤에도 기록을 조회할 수 있어야 한다. 일정·음성·파일·예약·Pro 전용 runtime은 그다음 단계다.
