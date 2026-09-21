# Mori k3s Knative 실습 설치

작성·갱신: 2026-09-21. **사용자 실행 출력으로 실제 Knative 설치 및 테스트 앱의 1→0→1 확인.** 상세 근거와 측정 한계는 [검증 기록](../knative-validation-2026-09-21.md)에 있다. 아래는 재현용 절차이며 현재 클러스터에 설치를 반복하라는 뜻이 아니다.

내부 HTTP 요청으로 테스트 Pod의 유휴 종료·재기동을 확인했다. 다음은 실제 Hermes 연결이다. 테스트 결과는 Hermes의 실제 기동 시간이나 장기 작업 안전성을 증명하지 않는다.

## 확인된 환경과 설치 설정

사용자가 제공한 출력 기준이며, 이 문서를 작성한 컴퓨터에서 클러스터에 직접 접속하지 않았다.

| 항목 | 값 |
| --- | --- |
| master | `k3s-server`, `192.168.0.100`, Pod CIDR `10.42.0.0/24` |
| worker | `k3s-infra`, `192.168.0.20`, Pod CIDR `10.42.1.0/24` |
| k3s | 양쪽 `v1.34.3+k3s1` |
| worker taint | `infra=true:NoSchedule` |
| 설치 전 실제 메모리 사용량 | master 10,435Mi / 66%, worker 5,344Mi / 22% |
| 설치 후 실제 메모리 사용량 | master 9,490Mi / 60%, worker 5,497Mi / 23%; 서로 다른 시점의 노드 전체 값 |
| UFW | master 비활성 유지, worker 활성 |
| worker 예약 메모리 | 17,024Mi / 71%; MinIO requests 16Gi 포함 |
| 기존 ingress | Traefik LoadBalancer, 80/443 |
| 메트릭 | worker UFW에서 master·master Pod 대역의 TCP 10250 허용 후 정상화 |

- Knative Serving/Kourier `1.23.0`을 사용한다. 이 버전의 최소 Kubernetes는 1.34다.
- Serving Deployment 4개와 Kourier Deployment 2개를 모두 `k3s-infra`에 배치하고 taint를 허용한다.
- 실습에서는 구성요소별 1개로 제한한다. 포함된 HPA 3개의 min/max replicas를 1로 설정한다. 고가용성 구성이 아니며 worker 중단 시 Knative도 중단된다.
- 기본 컨테이너 requests를 합하면 CPU 1코어, 메모리 760Mi다. 이는 **예약량**이며 실제 사용량이나 최대 사용량 예측이 아니다. 테스트 앱, queue-proxy, 클라이언트는 별도다.
- Kourier의 `kourier` Service를 적용 전에 ClusterIP로 변경한다. `kourier-internal`도 ClusterIP다.
- 테스트 Knative Service는 `cluster-local`, KPA, min 0 / max 1을 사용한다. max 1은 Revision별 제한이다.
- 시스템 Pod는 계속 실행되고 `coldstart-demo` Pod만 유휴 시 0개가 된다. 이 실습은 Eventing·외부 DNS·추가 포트포워딩을 사용하지 않는다.

## 1. 파일을 master로 복사

이 디렉터리 전체를 master의 `~/mori-knative-lab`로 복사한다. 별도로 제공된 압축 파일을 업로드했다면 master에서 다음을 실행한다.

```bash
cd ~
tar -xzf mori-knative-lab.tar.gz
cd ~/mori-knative-lab
```

실제 서버로 전송하는 작업은 사용자 컴퓨터에서 수행한다. **2절 방화벽 명령만 worker에서 실행하고, 나머지 Kubernetes·파일 준비·정리 명령은 모두 master에서 실행한다.** 블록별 결과를 확인하고 다음 단계로 넘어간다. 오류가 발생하면 다음 블록을 진행하지 않는다.

## 2. 내부 Pod 통신을 위한 UFW 설정

10250 허용은 메트릭 수집만 해결한다. Knative는 controller→API, API→webhook, Pod→DNS, gateway→activator/앱 통신도 사용한다. worker의 `deny (routed)`와 Pod 대역 허용 부재는 별도 경로를 막을 수 있다.

아래 규칙은 현재 두 노드의 Pod CIDR를 합친 `10.42.0.0/23`과 알려진 노드 IP만 사용한다. 해당 Pod들 사이에는 통신을 허용하는 초기 실습 정책이다. 사용자별 도구·파일 격리나 NetworkPolicy를 대신하지 않는다. 노드를 추가하면 CIDR 규칙을 다시 설계한다.

**master (`192.168.0.100`): UFW 비활성 상태를 유지한다. 이 절의 UFW 규칙 명령을 실행하거나 UFW를 새로 켜지 않는다.**

**worker (`192.168.0.20`)에서만** 기존 규칙을 기록하고 아래 규칙을 추가한다. 현재 활성 UFW 기준이다. 기존 SSH·메트릭 허용 규칙은 삭제하지 않는다.

```bash
hostname -I
sudo ufw status verbose
sudo ufw status numbered

# 현재 클러스터 Pod에서 worker로 들어오는 통신
sudo ufw allow from 10.42.0.0/23 to any comment 'Mori k3s pods to node'

# 두 노드의 Pod 사이 라우팅
sudo ufw route allow from 10.42.0.0/23 to 10.42.0.0/23 comment 'Mori k3s pod routing'

# master/worker에서 Pod로 향하는 webhook 등 내부 통신
sudo ufw route allow from 192.168.0.100 to 10.42.0.0/23 comment 'Mori master to pods'
sudo ufw route allow from 192.168.0.20 to 10.42.0.0/23 comment 'Mori worker to pods'

sudo ufw status verbose
```

worker는 제공된 출력에서 8472/UDP가 이미 허용돼 있고, 10250에는 master와 master Pod 대역 허용 규칙을 추가한 상태다. 이를 유지한다. UFW 변경은 즉시 반영된다. 이 규칙만으로 모든 경로가 정상이라는 뜻은 아니므로 아래 테스트에서 실제 통신을 확인한다.

## 3. 공식 파일 다운로드와 설치본 생성 — master

```bash
cd ~/mori-knative-lab
bash prepare.sh
mkdir -p rendered
sudo k3s kubectl kustomize serving > rendered/serving.yaml
sudo k3s kubectl kustomize kourier > rendered/kourier.yaml
```

`prepare.sh`는 공식 릴리스 파일 3개를 내려받기만 한다. 클러스터 적용은 하지 않는다. 별도의 Python, Helm, kn CLI 또는 Kustomize 설치도 필요하지 않다.

검토할 설정은 `serving/kustomization.yaml`, `kourier/kustomization.yaml`에 있다. 원본을 직접 적용하면 worker 지정과 ClusterIP 변경이 빠지므로 아래에서 **rendered 파일을 적용**한다.

현재 파일을 로컬에서 kubectl 1.34.3 내장 Kustomize로 렌더링했고, Deployment 배치, taint 허용, HPA 제한, Service 타입과 feature flag를 확인했다. 이후 사용자가 실제 배포·테스트 요청까지 수행한 출력도 확인했다. Hermes에 필요한 PVC 등 추가 필드는 이 검증에 포함되지 않는다.

## 4. Serving 설치 — master

```bash
sudo k3s kubectl apply -f serving-crds.yaml
sudo k3s kubectl wait --for=condition=Established crd \
  -l knative.dev/crd-install=true --timeout=120s
sudo k3s kubectl apply -f rendered/serving.yaml
sudo k3s kubectl -n knative-serving rollout status deployment/activator --timeout=300s
sudo k3s kubectl -n knative-serving rollout status deployment/autoscaler --timeout=300s
sudo k3s kubectl -n knative-serving rollout status deployment/controller --timeout=300s
sudo k3s kubectl -n knative-serving rollout status deployment/webhook --timeout=300s
sudo k3s kubectl -n knative-serving get pods -o wide
```

`activator`, `autoscaler`, `controller`, `webhook`의 rollout 성공과 Pod의 `READY` 상태를 확인한다. `NODE`는 `k3s-infra`여야 한다. 첫 설치의 이미지 다운로드는 시간이 걸릴 수 있다. 300초를 초과하면 오류 진단 절차로 이동한다.

## 5. Kourier 설치 — master

```bash
sudo k3s kubectl apply -f rendered/kourier.yaml
sudo k3s kubectl -n knative-serving rollout status deployment/net-kourier-controller --timeout=300s
sudo k3s kubectl -n kourier-system rollout status deployment/3scale-kourier-gateway --timeout=300s
sudo k3s kubectl -n knative-serving get pods -o wide
sudo k3s kubectl -n kourier-system get pods,svc -o wide
sudo k3s kubectl -n knative-serving get cm config-network config-features -o yaml
sudo k3s kubectl top nodes
```

통과 기준:

- Knative/Kourier의 Pod 6개 모두 Ready, worker 배치.
- `kourier`, `kourier-internal` 모두 `ClusterIP`.
- config-network 실제 data에 `ingress-class: kourier.ingress.networking.knative.dev`.
- config-features 실제 data에 `kubernetes.podspec-nodeselector: enabled`, `kubernetes.podspec-tolerations: enabled`.
- 기존 Harbor·Traefik 서비스가 동작하고 노드 메모리에 급격한 이상이 없음.

이 시점까지 확인되면 설치는 끝났고, 다음은 실제 요청 경로 검증이다.

## 6. 테스트 서비스와 클라이언트 생성 — master

```bash
sudo k3s kubectl apply -f test-namespace.yaml
sudo k3s kubectl apply --dry-run=server -f smoke.yaml
sudo k3s kubectl apply -f smoke.yaml
sudo k3s kubectl -n mori-knative-test wait --for=condition=Ready \
  ksvc/coldstart-demo --timeout=300s
sudo k3s kubectl apply -f client.yaml
sudo k3s kubectl -n mori-knative-test wait --for=condition=Ready \
  pod/knative-client --timeout=120s
sudo k3s kubectl -n mori-knative-test get ksvc,pods -o wide
```

공식 helloworld-go 샘플은 `TARGET=Mori`로 실행한다. 테스트 이미지의 latest 태그는 이 일회성 검증용이며, Hermes 운영 이미지는 검증된 digest로 고정해야 한다. 테스트에는 사용자 데이터나 PVC가 없다.

URL을 읽어서 **클러스터 내부의 클라이언트 Pod에서** 호출한다. master OS는 `svc.cluster.local`을 해석하지 못할 수 있으므로 master에서 URL을 직접 curl하지 않는다.

```bash
MORI_TEST_URL=$(sudo k3s kubectl -n mori-knative-test get ksvc coldstart-demo -o jsonpath='{.status.url}')
printf '%s\n' "$MORI_TEST_URL"
sudo k3s kubectl -n mori-knative-test exec knative-client -- \
  wget -q -T 120 -O - "$MORI_TEST_URL"
```

예상 응답은 `Hello Mori!`다. 클라이언트는 master, 테스트 서비스는 worker에 배치되어 노드 간 경로도 검증한다. URL은 클러스터 내부용이므로 외부 Tabby PC의 브라우저 주소로 사용하지 않는다.

## 7. 유휴 종료와 재기동 검증

master에 접속한 **터미널 A**에서 다음을 실행한다.

```bash
sudo k3s kubectl -n mori-knative-test get pods \
  -l serving.knative.dev/service=coldstart-demo -w
```

요청을 보내지 않고 기다리면 테스트 서비스 Pod가 종료된다. 테스트 설정은 window 60초 / 추가 scale-down-delay 0초이며, 종료 유예와 제어 주기로 실제 종료까지 수분이 걸릴 수 있다. 정확히 60초에 종료되는 계약은 아니다. 시스템 Pod와 `knative-client`가 남는 것은 정상이다.

master에 접속한 **터미널 B**에서 Pod가 0개인지 확인하고 다시 요청한다.

```bash
sudo k3s kubectl -n mori-knative-test get pods \
  -l serving.knative.dev/service=coldstart-demo
MORI_TEST_URL=$(sudo k3s kubectl -n mori-knative-test get ksvc coldstart-demo -o jsonpath='{.status.url}')
time sudo k3s kubectl -n mori-knative-test exec knative-client -- \
  wget -q -T 120 -O - "$MORI_TEST_URL"
```

터미널 A에서 새 Pod가 생기고 터미널 B에 `Hello Mori!`가 반환되면 0→1 동작 성공이다. 요청 종료 후 다시 0개가 되는지 확인한다. 반복 호출은 유휴 종료를 지연시킨다. `time`은 kubectl exec 비용도 포함한 참고값이며 Hermes 기동 시간으로 해석하지 않는다.

```bash
sudo k3s kubectl top nodes
sudo k3s kubectl top pods -n knative-serving
sudo k3s kubectl top pods -n kourier-system
```

검증이 끝나면 이번에 만든 테스트 리소스만 정리한다.

```bash
sudo k3s kubectl -n mori-knative-test delete ksvc coldstart-demo
sudo k3s kubectl -n mori-knative-test delete pod knative-client
sudo k3s kubectl delete namespace mori-knative-test
```

위 namespace는 이번 실습 전용일 때만 삭제한다. Knative/Kourier namespace와 CRD는 유지한다. 삭제 결과 출력은 아직 별도로 확인하지 않았다.

master에 임시로 복사한 설치 파일도 제거하려면 다음을 실행한다. Git에 저장한 원본은 유지한다.

```bash
cd ~
ls -ld /home/dongyeop/mori-knative-lab /home/dongyeop/mori-knative-lab.tar.gz
rm -r -- /home/dongyeop/mori-knative-lab
rm -- /home/dongyeop/mori-knative-lab.tar.gz
```

설치 파일 삭제는 이미 적용한 Kubernetes 리소스를 삭제하지 않는다. 서버에서 삭제 후 다시 작업할 때에는 이 디렉터리를 Git에서 복사해 `prepare.sh`로 생성한다.

## 오류 진단과 중단

| 증상 | 먼저 확인할 것 |
| --- | --- |
| Pending | `describe pod` Events의 taint, Insufficient memory/CPU, nodeSelector |
| ImagePullBackOff | worker의 레지스트리 접근, 이미지 이름과 인증 |
| webhook timeout | master→worker Pod 경로, UFW routed 규칙, webhook EndpointSlice |
| Route Ready 실패 또는 503 | Kourier/controller/activator 상태, Pod 간 통신, 서비스 이벤트 |
| DNS 오류 | master의 CoreDNS 접근, UDP/TCP 53, 클라이언트가 Pod 내부인지 |
| Pod가 계속 1개 | 요청·모니터링이 계속 유입되는지, KPA 설정, 종료 대기 시간 |

아래 명령은 조회용이다. 실패 원인을 확인하기 전에 전체 설치 파일을 삭제하거나 CRD를 삭제하지 않는다. Knative CRD 삭제는 해당 유형의 사용자 리소스도 삭제할 수 있다.

```bash
sudo k3s kubectl -n knative-serving get pods -o wide
sudo k3s kubectl -n kourier-system get pods,svc -o wide
sudo k3s kubectl -n knative-serving get events --sort-by=.lastTimestamp
sudo k3s kubectl -n kourier-system get events --sort-by=.lastTimestamp
sudo k3s kubectl -n mori-knative-test get events --sort-by=.lastTimestamp
sudo k3s kubectl -n knative-serving logs deployment/controller --tail=80
sudo k3s kubectl -n knative-serving logs deployment/net-kourier-controller --tail=80
```

아직 생성되지 않은 namespace나 Deployment의 조회 오류는 해당 단계까지 설치가 진행되지 않았음을 뜻할 수 있다. 문제 Pod의 이름이 확인되면 `kubectl -n <namespace> describe pod <name>`도 확인한다.

## 다음 단계: Hermes

이 실습의 기본 종료·재기동이 확인됐으므로 다음으로 공용 Hermes의 실제 단일 요청→llama.cpp 호출을 확인하고 Knative Service를 작성한다. Hermes에는 저장소/PVC, initContainer, 보안 컨텍스트, Gateway 인증, 모델 서버 연결이 추가로 필요하다. [기존 전환 절차](../knative-serving.md)를 따른다. 기존 Deployment와 새 Revision이 같은 home에 동시에 쓰지 않도록 한다.

Hermes 실험의 유휴 지연 10분과 테스트 앱의 짧은 유휴 설정은 용도가 다르다. 긴 비동기 작업·승인 대기·예약 실행은 Mori의 영속 작업 관리와 별도로 연결해야 한다.

## 공식 근거

- [Knative Serving YAML 설치](https://knative.dev/docs/install/yaml-install/serving/install-serving-with-yaml/)
- [Knative 릴리스 호환 표](https://github.com/knative/community/blob/main/mechanics/RELEASE-SCHEDULE.md)
- [nodeSelector와 tolerations 기능 플래그](https://knative.dev/docs/serving/configuration/feature-flags/)
- [클러스터 내부 서비스](https://knative.dev/docs/serving/services/private-services/)
- [확장 범위와 유휴 지연](https://knative.dev/docs/serving/autoscaling/scale-bounds/)
- [k3s 네트워크·UFW 요구사항](https://docs.k3s.io/installation/requirements)
