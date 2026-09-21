# 공용 Hermes 테스트 — 집에서 이어서 진행할 절차

[전체 계획](../plan.md) · [아키텍처](plan.md) · [검색·경량화 방향](hermes-search-runtime.md) · [Knative 검증 기록](knative-validation-2026-09-21.md)

갱신일: 2026-09-21. **현재 중단 지점은 노드·저장소·기존 리소스 조회 완료다.** 사용자는 이후 과정을 집에서 진행할 예정이다. 네임스페이스 생성, 모델 ID 조회, Secret 생성, Hermes 배포는 안내만 했으며 실행 결과를 받지 않았다. 이 문서를 갱신하면서 클러스터를 변경하지 않았다.

## 1. 확인한 사실과 아직 하지 않은 일

근거는 사용자가 제공한 2026-09-21 17:12경 KST의 `kubectl` 출력이다. AI가 원격 접속해 확인한 결과가 아니다. 원본의 장비 식별자·노드 인증 관련 annotation은 문서에 복사하지 않는다.

| 항목 | 확인된 상태 |
| --- | --- |
| master | `k3s-server`, `192.168.0.100`, Ready, k3s `v1.34.3+k3s1`, amd64 |
| worker | `k3s-infra`, `192.168.0.20`, Ready, 같은 k3s 버전, amd64 |
| worker 배치 조건 | `kubernetes.io/hostname=k3s-infra`, `infra=true:NoSchedule` taint, `mori-agent=true` 라벨 없음 |
| worker 자원 | CPU 12코어, 메모리 24,442,468Ki(약 23.3GiB), requests CPU 1,300m·메모리 17,784Mi(74%) |
| 예약량 해석 | 메모리 미예약량 약 5.9GiB. 실제 여유 메모리·안전한 최대 사용량을 뜻하지 않음. 일부 기존 Pod는 requests가 0이며 MinIO requests는 16Gi |
| 노드 상태 | MemoryPressure/DiskPressure/PIDPressure 모두 False, 노드 Events 없음 |
| 저장소 | 기본 `local-path`, `WaitForFirstConsumer`, reclaim `Delete`, 볼륨 확장 불가 |
| Mori | `mori` namespace가 없다는 NotFound 확인. 공용 Hermes Deployment/Service/PVC/Secret 미배포 |
| 기존 서비스 | worker에 Harbor·Argo CD·PostgreSQL·MinIO 및 Knative/Kourier Pod가 배치됨. 기존 서비스의 기능 회귀 검증을 뜻하지 않음 |
| GPU 모델 서버 | 사용자 설명 기준 `192.168.0.8:8080` llama.cpp, API 키 사용. 이번 출력에 `/v1/models` 결과는 없음 |
| Knative | 앞선 로그에서 시스템 Pod 6개 Ready, Kourier ClusterIP, 샘플 1→0→1과 Hello Mori! 확인. 실제 Hermes는 미검증 |

샘플 테스트의 1.140초를 Hermes 기동·모델 응답 시간으로 사용하지 않는다. 테스트 namespace·설치 압축 파일 삭제는 안내했으나 삭제 완료 출력은 받지 않았다. Knative를 다시 설치하거나 방화벽 설정부터 반복하지 않는다.

## 2. 이번 첫 목표와 장비별 역할

첫 목표는 **테스트 요청 → 공용 Hermes 일반 Deployment → 기존 llama.cpp → 실제 답변**이다. 처음에는 신뢰된 단일 시험 사용자만 사용한다. 일반 Deployment의 첫 요청을 확인한 뒤 SearXNG 도구 호출, 실제 Hermes Knative 전환, Mori 주차 도구 연결로 진행한다.

| 실행 위치 | 담당 작업 |
| --- | --- |
| master `192.168.0.100`의 Bash 터미널 | 아래 관리 명령, namespace/Secret 생성, 매니페스트 적용, 포트포워딩·API 테스트 |
| worker `192.168.0.20` | Kubernetes가 Hermes·검색 Pod를 배치할 위치. SSH로 Docker 컨테이너를 별도 실행하지 않음 |
| GPU 노트북 `192.168.0.8:8080` | 이미 구동 중인 llama.cpp 유지. GPU 장비 검증이나 k3s 편입을 다시 하지 않음 |
| 개발 작업의 `master` 브랜치 | AI가 실제 배포 파일·Adapter·도구 구현을 수정하고 검증할 위치 |
| 이 `plan` 브랜치 | 절차·결정·결과 기록. 여기에 제품 배포 파일이 있다고 가정하지 않음 |

공식 `nousresearch/hermes-agent` 이미지로 첫 연결을 검증할 수 있으므로 **지금 자체 이미지 빌드는 필수가 아니다.** 실제 사용할 버전/digest는 배포 파일 준비 단계에서 확정한다. Harbor 복제는 선택이며 아직 주소·프로젝트·pull 인증이 확인되지 않았다. 새 경량 이미지와 자원별 이미지를 먼저 만들 필요는 없다.

## 3. 집에서 먼저 실행할 준비 절차

모든 명령은 **master의 Bash**에서 실행한다. root 셸에서도 아래 `sudo k3s` 표기를 그대로 사용할 수 있다. API 키를 채팅·Git에 넣거나 `set -x`로 명령을 추적하지 않는다.

### 3.1 재개 시점의 상태 확인과 namespace 생성

```bash
sudo k3s kubectl get nodes -o wide
sudo k3s kubectl -n mori get deployment,service,pvc
sudo k3s kubectl -n mori get secret mori-hermes
sudo k3s kubectl top nodes
```

이 문서 작성 시점에는 namespace가 없었다. 재개할 때 이미 리소스가 있다면 삭제·덮어쓰기 전에 어떤 단계까지 실행했는지 먼저 대조한다. 아래 namespace 명령은 재실행할 수 있다.

```bash
sudo k3s kubectl create namespace mori --dry-run=client -o yaml |
  sudo k3s kubectl apply -f -
sudo k3s kubectl get namespace mori
```

완료 기준: namespace `Active`. 이는 Hermes가 설치됐다는 뜻은 아니다.

### 3.2 실제 모델 ID 확인

입력한 키는 화면에 표시되지 않는다. 아래 블록은 별도 서브셸에서 키를 읽고 끝나면 변수를 없앤다.

```bash
(
  read -rsp 'llama.cpp API key: ' MORI_LLAMA_KEY
  printf '\n'
  test -n "$MORI_LLAMA_KEY" || exit 1
  curl --noproxy '*' -fsS --connect-timeout 5 --max-time 20 \
    -H "Authorization: Bearer $MORI_LLAMA_KEY" \
    http://192.168.0.8:8080/v1/models
)
```

완료 기준: JSON의 `data[].id`를 확인해 사용할 모델 ID를 기록한다. 모델이 여러 개라면 사용할 ID를 명시적으로 고른다. `Qwen3.8`이라는 제품명이나 GGUF 파일명을 임의로 넣지 않는다. `401`은 인증 확인, timeout/연결 거절은 주소·포트·통신 경로 확인 대상이다. 실패한 경우 원인을 해결하고 다음 단계로 진행한다.

이 요청은 master에서 모델 서버로의 접속 확인이다. worker Pod의 실제 연결·도구 호출 지원은 뒤의 Hermes 실행으로 따로 검증한다.

### 3.3 인증 Secret 생성

`LLAMA_API_KEY`는 Hermes→llama.cpp, `API_SERVER_KEY`는 테스트 클라이언트/Mori→Hermes 인증이다. 기존 Secret이 없는 경우에만 다음을 실행한다. `AlreadyExists`가 나오면 기존 키를 회전시키지 말고 준비 상태를 확인한다.

```bash
(
  set -e
  umask 077
  MORI_SECRET_DIR=$(mktemp -d)
  trap 'rm -rf -- "$MORI_SECRET_DIR"' EXIT
  read -rsp 'llama.cpp API key: ' MORI_LLAMA_KEY
  printf '\n'
  test -n "$MORI_LLAMA_KEY"
  printf '%s' "$MORI_LLAMA_KEY" > "$MORI_SECRET_DIR/LLAMA_API_KEY"
  openssl rand -hex 32 > "$MORI_SECRET_DIR/generated-key"
  tr -d '\n' < "$MORI_SECRET_DIR/generated-key" > "$MORI_SECRET_DIR/API_SERVER_KEY"
  sudo k3s kubectl -n mori create secret generic mori-hermes \
    --from-file=LLAMA_API_KEY="$MORI_SECRET_DIR/LLAMA_API_KEY" \
    --from-file=API_SERVER_KEY="$MORI_SECRET_DIR/API_SERVER_KEY"
)
sudo k3s kubectl -n mori get secret mori-hermes
```

완료 기준: `secret/mori-hermes created`와 조회의 `DATA 2`. 생성한 Hermes 키는 Secret에 보존된다. 출력으로 공유할 것은 namespace 상태, 실제 모델 ID, Secret 생성 성공 여부이며 키 자체는 필요 없다.

**여기까지가 지금 실행 가능한 준비 단계다. 이후에는 실제 모델 ID와 고정 이미지를 반영한 `master` 배포 파일이 먼저 필요하다.**

## 4. AI가 `master`에서 준비해야 할 배포 변경 — 미구현

현재 기준은 `master` 커밋 `55652f6`의 `infra/k3s/hermes-shared.yaml`이다. 그대로 적용하지 않는다.

- `REPLACE_MODEL_ID`를 3.2에서 얻은 실제 ID로 교체한다. provider 주소는 확인된 `http://192.168.0.8:8080/v1`을 사용한다.
- `nousresearch/hermes-agent:latest`를 확인한 amd64 지원 버전/digest로 고정하고 해당 버전의 Gateway·설정·API 동작을 검증한다.
- nodeSelector를 `kubernetes.io/hostname: k3s-infra`로 맞추고 `infra=true:NoSchedule` toleration을 추가한다.
- namespace `mori`, Secret `mori-hermes`, API 8642와 내부 ClusterIP 연결을 확인한다. API 활성화·`0.0.0.0` bind·인증 키 설정이 필요하다.
- `/opt/data`에 5Gi `local-path` PVC를 연결하고 initContainer의 설정 복사·소유권, 이미지 UID/GID·쓰기 권한을 검증한다.
- 초안의 `replicas: 1`, `Recreate`를 유지해 첫 실행을 확인한다. requests 250m/512Mi, limits 2CPU/4Gi는 초기 실험값이며 측정된 필요 자원이 아니다.
- 첫 테스트의 외부 keyless 검색 fallback/rescue를 끄고, 단순 대화 확인 전 검색이나 임의 도구 실행을 요구하지 않는다. 설정 키는 고정한 버전으로 확인한다.
- `health`와 모델 준비 상태를 구분하고 startup/readiness 및 실제 대화를 확인한다.

Harbor를 사용할 때에는 공식 이미지 미러링과 자체 이미지 빌드를 구분한다. 주소·프로젝트·TLS 신뢰·imagePullSecret을 준비한 뒤 worker가 pull하는 경로를 확인한다. 이번 기록에서는 Harbor 이미지 등록·빌드를 완료로 표시하지 않는다.

## 5. 수정된 배포 파일을 받은 뒤 실행할 절차

아래는 **4절의 수정·검증된 파일을 master 서버에 준비한 후** 실행한다. 서버에 저장소가 이미 있거나 `/home/dongyeop/mori`에 있다고 가정하지 않는다. 해당 서버의 실제 `master` 브랜치 checkout/전달받은 파일 위치로 이동한다. `plan` checkout에서 제품 YAML을 찾지 않는다.

```bash
sudo k3s kubectl apply -f infra/k3s/hermes-shared.yaml
sudo k3s kubectl -n mori rollout status deployment/mori-hermes-shared --timeout=300s
sudo k3s kubectl -n mori get pods -l app=mori-hermes-shared -o wide
sudo k3s kubectl -n mori get pvc mori-hermes-shared-home
```

완료 기준: worker에서 Pod `1/1 Running`, PVC `Bound`. `WaitForFirstConsumer`이므로 Pod 배치 전 PVC Pending은 즉시 장애로 판단하지 않는다. 첫 이미지 다운로드 시간을 포함한 timeout은 원인을 확인하며, 무조건 재배포하지 않는다.

master SSH 터미널 A에서 다음 명령을 실행한 채 유지한다.

```bash
sudo k3s kubectl -n mori port-forward service/mori-hermes-shared 8642:8642
```

**같은 master에 접속한 터미널 B**에서 확인한다. `127.0.0.1`은 사용자 PC가 아니라 master다. 아래 키 조회는 화면에 키를 출력하지 않는다.

```bash
curl -fsS --max-time 10 http://127.0.0.1:8642/health
(
  set -e
  MORI_HERMES_KEY=$(sudo k3s kubectl -n mori get secret mori-hermes \
    -o jsonpath='{.data.API_SERVER_KEY}' | base64 --decode)
  test -n "$MORI_HERMES_KEY"
  curl -fsS --max-time 180 http://127.0.0.1:8642/v1/chat/completions \
    -H "Authorization: Bearer $MORI_HERMES_KEY" \
    -H 'Content-Type: application/json' \
    -d '{"model":"hermes-agent","messages":[{"role":"user","content":"안녕. 한국어로 짧게 인사해줘."}],"stream":false}'
)
```

완료 기준: 인증된 요청으로 실제 모델 답변을 받는다. 180초는 테스트 timeout이며 예상 지연 시간이 아니다. `/health` 또는 Pod Running만으로 통과 처리하지 않는다. Chat Completions의 대화는 요청의 `messages`로 전달하므로 별도 요청이 앞선 대화를 자동 기억한다고 검증하지 않는다.

문제가 있으면 master에서 다음 결과를 확인한다. 로그를 공유하기 전 키·개인 정보를 가린다.

```bash
sudo k3s kubectl -n mori describe pod -l app=mori-hermes-shared
sudo k3s kubectl -n mori logs deployment/mori-hermes-shared -c write-config --tail=80
sudo k3s kubectl -n mori logs deployment/mori-hermes-shared -c hermes --tail=100
sudo k3s kubectl -n mori top pod -l app=mori-hermes-shared
```

| 증상 | 먼저 볼 항목 |
| --- | --- |
| Pending | selector/toleration, requests 예약 여유, PVC/스토리지 이벤트 |
| ImagePullBackOff | 고정 이미지 존재·플랫폼, registry 접속·인증·TLS |
| init 실패 | 미교체 모델 ID, config 파일, PVC 권한 |
| health 성공·대화 실패 | 모델 주소·키·ID, worker Pod→llama.cpp 경로, 모델 형식·timeout |
| OOMKilled | 실제 메모리 사용과 limit, 기능·동시 실행량; 무조건 limit만 확대하지 않음 |

## 6. 이후 순서와 완료 기준

| 순서 | 작업 | 완료 증거 |
| --- | --- | --- |
| 1 | 위의 단일 Hermes↔LLM 대화 | 실제 답변, 실행 이미지 ID, worker 배치·PVC 상태 |
| 2 | SearXNG 자체 호스팅과 Hermes 연결 | 내부 JSON 검색, 실제 `web_search` 실행·결과·출처를 사용한 후속 답변. [설계](hermes-search-runtime.md) |
| 3 | 실제 Hermes Knative 전환 | 동일 home의 단일 작성자, 내부 Route로 0→1→0, 상태 보존·실제 기동/응답 시간. [전환 가이드](knative-serving.md) |
| 4 | Mori Adapter·주차 도구 | “지하 2층 C구역 C36에 주차했어” → 인증 사용자 DB 저장 → 재조회. DB 성공 후 응답, 재시도 중복 방지 |
| 이후 | 경량 이미지·Pro 전용 실행·본문/파일 Worker | 기능 회귀·메모리·기동 실측, 사용자 격리, 개별 도구 인수 |

검색 검증은 새로 추가한 소규모 도구 호출 단계이며, 검색 제공자가 준비되지 않아도 첫 주차 도구 구현 자체의 필수 의존성은 아니다. Knative 테스트 시 기존 Deployment와 새 Revision이 같은 home에 동시에 쓰지 않도록 한다. 예약 작업은 별도 Mori DB/Worker에서 관리하고, Pod 안의 타이머만 믿지 않는다.

모리 API의 자연어 입력 경로, Hermes Adapter, `parking.save`/`parking.latest`는 아직 구현해야 한다. Hermes가 “저장했다”고 답하는 것만으로 모리 DB 저장을 인정하지 않는다. Free/Pro는 최고 관리자 승인·회수 기준이며 결제 작업은 포함하지 않는다.

## 7. 실행 후 기록할 항목

- [ ] namespace 생성, 실제 모델 ID 확인, Secret 생성(키 값 제외)
- [ ] 사용한 `master` 커밋·고정 이미지 digest·배포 시각
- [ ] Pod 노드·PVC Bound·health·실제 대화 결과
- [ ] 일반 대화와 도구 호출 지연, CPU/RAM, 오류와 조치
- [ ] SearXNG 검색 결과 및 Hermes 도구 호출 증거
- [ ] 실제 Hermes의 0→1→0·상태 보존 결과
- [ ] 모리 사용자별 주차 DB 저장·조회·격리 결과

공식 참고: [Hermes Docker](https://hermes-agent.nousresearch.com/docs/user-guide/docker), [API Server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server), [llama.cpp 서버](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md). 2026-09-21 확인. 이번 기록은 배포 성공 보고가 아니라 재개 절차다.
