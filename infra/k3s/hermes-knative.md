# Hermes의 첫 Knative 전환과 0→1 요청 검사

2026-09-29: 사용자 출력으로 Harbor `0.1.0` 업로드, 일반 Deployment 기동, 실제 모델 검색·본문 추출 성공을 확인했다. 아래는 **아직 현장 미검증인 전환 절차**다. 이미지 재빌드 없이 현재 이미지·Secret·ConfigMap·PVC를 사용한다. 예약 실행·Mori API 연동·Pro 자동 생성은 포함하지 않는다.

전제: Knative Serving/Kourier 1.23.0 설치, 단일 시험 사용자, 기존 Hermes는 유휴 상태이고 실행 중인 예약/문서 작업이 없어야 한다. 앞으로의 예약 prewarm/작업 lease는 별도 기능이다. 자원 한도는 현재 Deployment에서 복사한다. 초기 실험은 max 1/concurrency 1, window 60초, 추가 scale-down-delay 0초다. 정상 사용 시 대기 시간은 실측 후 늘린다.

모든 명령은 **k3s master의 Git master 저장소 루트**에서 실행한다. 먼저 `git status --short`를 확인하고 깨끗한 master에서 `git pull --ff-only origin master`로 갱신한다. 명령이 실패하면 다음 변경으로 넘어가지 않는다.

## 1. 기반과 원본 확인 — 아직 중단 없음

```sh
sudo k3s kubectl -n knative-serving get pods
sudo k3s kubectl -n kourier-system get pods,svc
sudo k3s kubectl -n knative-serving get configmap config-autoscaler -o yaml
python3 scripts/runtime/prepare_knative.py
```

모든 시스템 Pod가 Ready여야 한다. `config-autoscaler`의 실제 `data.enable-scale-to-zero`가 `false`라면 중단하고 확인한다(설정 생략 시 기본 true, `_example` 문자열은 실제 설정이 아님). 생성기는 기존 Bound PVC와 digest 고정 이미지를 확인하고 JSON 형식의 Kubernetes 매니페스트를 `.local/knative/`에 쓴다. JSON도 `kubectl apply -f`로 적용할 수 있다. 비밀 값은 읽거나 쓰지 않는다. 기존 Knative Service가 있으면 새 Revision을 만들지 않도록 실패한다.

## 2. 필요한 Knative 필드 허용·서버 검증

```sh
sudo k3s kubectl -n knative-serving patch configmap config-features \
  --type merge --patch-file .local/knative/features-patch.json
sudo k3s kubectl apply --dry-run=server -f .local/knative/hermes-service.json
```

nodeSelector/tolerations/initContainers/securityContext/PVC/PVC 쓰기 플래그만 병합하며 다른 설정은 보존한다. 이 기능 허용은 클러스터 전체에 적용된다. webhook이 설정을 인지하는 데 잠깐 시간이 걸릴 수 있다. 거절되면 원본 Deployment를 내리지 말고 오류를 확인한다.

[Knative 기능 플래그](https://knative.dev/docs/serving/configuration/feature-flags/) · [PVC](https://knative.dev/docs/serving/services/storage/).

## 3. 저장 보존 기준 파일과 독립 클라이언트 준비

```sh
python3 scripts/smoke/knative.py --mode marker-create
sudo k3s kubectl apply -f .local/knative/client.json
sudo k3s kubectl -n mori wait --for=condition=Ready pod/mori-hermes-coldstart-client --timeout=300s
```

`/opt/data/.mori-coldstart-probe`만 생성하고 해시를 서버의 `.local/knative/marker.sha256`에 기록한다. 기존 대화/기억 파일은 수정하지 않는다. 클라이언트는 이미 캐시된 Hermes 이미지를 쓰되 gateway 대신 sleep만 실행하고 요청할 때 Python 검사기를 실행한다. PVC/GPU 키는 연결하지 않으며 Hermes API Secret만 환경변수로 받는다. 테스트 동안 상시 실행되는 보조 Pod이며 Hermes가 아니다. 하루 뒤 종료되므로 끝나면 삭제한다.

## 4. 기존 작성자를 멈춘 뒤 전환

```sh
sudo k3s kubectl -n mori scale deployment/mori-hermes-shared --replicas=0
sudo k3s kubectl -n mori wait --for=delete pod -l app=mori-hermes-shared --timeout=300s
python3 scripts/smoke/knative.py --mode check-stopped
sudo k3s kubectl apply -f .local/knative/hermes-service.json
sudo k3s kubectl -n mori wait --for=condition=Ready ksvc/mori-hermes-knative --timeout=600s
sudo k3s kubectl -n mori get ksvc mori-hermes-knative
```

`check-stopped`가 실패하면 apply하지 않는다. 같은 PVC의 모든 Pod(종료 중 포함)가 사라진 것을 확인한다. 새 Pod의 labels에는 기존 `app=mori-hermes-shared`를 복사하지 않으므로 구형 Service가 Knative Pod로 우회 연결되지 않는다. PVC/Secret/기존 Deployment·Service는 삭제하지 않는다. 재설치용 `.local/manifests/hermes.yaml`을 적용하면 기존 replicas 1이 다시 살아나므로 전환 중/전환 후에는 적용하지 않는다.

## 5. 자동 1→0 관찰

```sh
sudo k3s kubectl -n mori get pods -l serving.knative.dev/service=mori-hermes-knative -w
```

60초 관측 창과 네트워크 전환·종료 유예를 거치므로 정확히 60초에 사라지는 것은 아니다. 수분 걸릴 수 있다. 이 동안 HTTP health 요청을 반복하지 않는다. `kubectl get` 자체는 Hermes HTTP 요청이 아니다. Pod 종료가 보이면 Ctrl+C(관찰만 중지) 후 목록이 비었는지 확인한다.

```sh
sudo k3s kubectl -n mori get pods -l serving.knative.dev/service=mori-hermes-knative
sudo k3s kubectl -n mori get pvc mori-hermes-shared-home
```

Pod 0개와 PVC Bound를 확인한다. 이 단계에서 수동 Pod 삭제/Deployment scale은 사용하지 않는다.

## 6. 0개에서 깨우기·저장 보존

```sh
python3 scripts/smoke/knative.py --mode health --require-zero
python3 scripts/smoke/knative.py --mode marker-check
```

검사는 기존 Deployment 중지와 Knative Pod 0개를 확인하고, **독립 클라이언트 → status.url의 cluster-local Route → Knative → Hermes**로 인증된 요청을 보낸다. 반복 HTTP 재시도 없이 최대 300초 기다린다. Pod가 남아 있으면 cold PASS 대신 중단한다. 요청부터 응답까지 걸린 시간, 새 Pod 이름·생성/Ready 시각을 출력한다. health는 LLM 추론 없이 기동+라우팅+API 응답 시간을 재고, 다음 model 검사는 추론 시간까지 포함한다. 한 번의 수치는 평균/p95가 아니다.

`marker-check`는 저장 파일 보존만 확인하며 대화 기억 복원 전체를 증명하지 않는다. timeout 시 원격 작업 취소가 보장되지 않으므로 바로 재시도하지 않는다.

## 7. 실제 모델도 0개에서 실행

다시 5번처럼 자동으로 Pod가 없어질 때까지 기다린 뒤 실행한다.

```sh
python3 scripts/smoke/knative.py --mode search --require-zero
python3 scripts/smoke/knative.py --mode marker-check
```

검색 요청 자체가 Pod를 깨우며 사전 health 요청을 보내지 않는다. 실제 web_search 호출/성공 결과/답변 출처를 이미지에 포함된 검증기로 확인한다. 이어서 일반 기동 상태에서 본문 추출도 확인할 수 있다.

```sh
python3 scripts/smoke/knative.py --mode extract
```

기존 `scripts/smoke/runtime.py`는 일반 Deployment의 Ready Pod를 대상으로 하므로 이 전환 테스트에는 사용하지 않는다. model 응답 300초 제한/네트워크/도구 실패는 로그와 구분한다.

## 8. 실패 원인 확인·원래 Deployment로 복구

```sh
sudo k3s kubectl -n mori describe ksvc mori-hermes-knative
sudo k3s kubectl -n mori get revision,pods -o wide
sudo k3s kubectl -n mori get events --sort-by=.lastTimestamp
```

복구 시 Knative Service와 종속 리소스를 먼저 정리하고, PVC 작성자가 없는 것을 확인한 다음 원본을 켠다.

```sh
sudo k3s kubectl -n mori delete ksvc mori-hermes-knative --cascade=foreground --timeout=300s
python3 scripts/smoke/knative.py --mode check-stopped
sudo k3s kubectl -n mori scale deployment/mori-hermes-shared --replicas=1
sudo k3s kubectl -n mori rollout status deployment/mori-hermes-shared --timeout=600s
```

삭제/종료 확인이 실패하면 원본을 켜지 않는다. PVC와 Secret은 유지된다. Knative 기능 플래그를 무조건 되돌리면 다른 서비스를 깨뜨릴 수 있으므로 이 절차에서 되돌리지 않는다.

성공 또는 복구 후 보조 클라이언트만 정리한다.

```sh
sudo k3s kubectl -n mori delete pod mori-hermes-coldstart-client --ignore-not-found
```

## 운영으로 확장할 때

이 도구는 최초 공용 runtime 전환을 위한 검사다. 같은 PVC를 쓸 새 Revision을 apply하면 max-scale 1이어도 이전 Revision과 겹칠 수 있으므로 그대로 업데이트하지 않는다. 모든 이전 작성자 종료를 확인하는 유지보수 절차/컨트롤러가 필요하다. RWO는 같은 노드의 두 Pod 작성을 막는 잠금이 아니다.

Pro에서는 같은 이미지에 사용자별 서비스/PVC/Secret/자원 제한을 지정하고, 사용자→runtime→Route 매핑과 승인/회수 시 자원 처리를 구현한다. 예약 내용은 Hermes가 관리하고 Mori는 최소 기동 메타데이터를 동기화하는 합의 방향이다. 예약 사전 기동·실행 중 유지·완료 결과 반영·다음 기동 시각 동기화는 이번 HTTP 실험과 분리한다.
