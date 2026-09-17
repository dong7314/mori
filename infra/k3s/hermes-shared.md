# 공용 Hermes Gateway를 기존 k3s worker에서 실행하기

현재 알려진 배치는 k3s server 미니 PC, k3s worker 노트북, 그리고 k3s 밖에서 llama.cpp를 실행 중인 Linux RTX 3090 eGPU 노트북이다. 사용자 설명에 따르면 GPU 노트북의 LAN 주소는 `192.168.0.8`, llama.cpp 포트는 `8080`이며 API 키가 설정되어 있다. worker에서 접근과 `/v1/models`의 모델 ID를 확인한 뒤 적용한다. 이 문서는 클러스터에 적용한 기록이 아니라 배포 절차다.

## 네트워크

같은 사설 LAN에서 Hermes가 GPU 노트북으로 나가는 연결에는 공유기에서 22·443 포트를 포워딩할 필요가 없다. GPU 노트북의 호스트 방화벽에서 **llama.cpp가 실제 듣는 포트**를 k3s worker에서 접근할 수 있게 하고, `llama-server`가 `127.0.0.1`만이 아니라 LAN 인터페이스에서 듣는지 확인한다. 22번은 별도 SSH 관리, 443번은 별도 HTTPS 프록시를 설정할 때만 필요하다. 모델 API는 인터넷에 공개하지 않는다.

worker 노트북에서 다음을 먼저 확인한다. API 키는 이 문서나 Git에 적지 않는다.

```sh
read -rsp 'llama.cpp API key: ' LLAMA_API_KEY; echo
curl -fS http://192.168.0.8:8080/health
curl -fS http://192.168.0.8:8080/v1/models \
  -H "Authorization: Bearer $LLAMA_API_KEY"
unset LLAMA_API_KEY
```

`/health`가 정상이면 모델 적재가 끝난 것이다. `/v1/models`의 `data[0].id`를 [hermes-shared.yaml](hermes-shared.yaml)의 `model.default`에 적는다. 포트가 8080이 아니라면 두 요청과 매니페스트의 `providers.lan_llama.api`를 함께 바꾼다. `192.168.0.8`은 ipTIME DHCP 예약 등으로 유지한다. [llama.cpp 서버 API](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).

## 배포

매니페스트는 공식 `nousresearch/hermes-agent` 이미지를 `gateway run`으로 실행하고 `/opt/data`를 PVC에 보존한다. `Recreate` 배포 전략으로 같은 Hermes home에 두 Pod가 동시에 쓰지 않게 한다. `local-path` PVC는 초기에는 worker 노트북에 묶이는 저장소로 취급하므로 해당 노드를 고정하고 별도 백업을 준비한다. 이미지 `latest`, CPU·RAM 한도, 5Gi 저장소는 첫 실행 값이며 확인된 운영 사양이 아니다. 버전 확인 후 이미지를 태그 또는 digest로 고정한다. [Hermes Docker 운영](https://hermes-agent.nousresearch.com/docs/user-guide/docker).

아래 명령은 k3s 관리 권한이 있는 Linux 셸에서 저장소 `master` 브랜치의 루트에서 실행한다.

```sh
kubectl get nodes -o wide
kubectl get storageclass local-path
kubectl create namespace mori --dry-run=client -o yaml | kubectl apply -f -
kubectl label node <기존_worker_노드명> mori-agent=true --overwrite
```

Hermes API 키를 새로 만들고 이미 운영 중인 llama.cpp API 키를 읽어 Secret에 넣는다. 키를 채팅·Git에 보내지 않는다.

```sh
read -rsp 'llama.cpp API key: ' LLAMA_API_KEY; echo
HERMES_API_KEY=$(openssl rand -hex 32)
kubectl -n mori create secret generic mori-hermes \
  --from-literal=LLAMA_API_KEY="$LLAMA_API_KEY" \
  --from-literal=API_SERVER_KEY="$HERMES_API_KEY"
unset LLAMA_API_KEY
kubectl apply -f infra/k3s/hermes-shared.yaml
kubectl -n mori rollout status deployment/mori-hermes-shared
kubectl -n mori get pods -o wide
```

`HERMES_API_KEY`는 검증과 이후 Mori Adapter에 필요하므로 안전하게 보관한다. ConfigMap의 변경은 PVC의 `config.yaml`에 새로 복사되도록 `kubectl -n mori rollout restart deployment/mori-hermes-shared`를 실행한다. 이 매니페스트는 기본 profile의 설정을 선언적으로 관리한다.

## 동작 확인

먼저 다른 터미널에서 내부 Service를 로컬로 포워딩한다.

```sh
kubectl -n mori port-forward service/mori-hermes-shared 8642:8642
```

관리 셸에서 API와 모델 호출을 확인한다.

```sh
curl -fS http://127.0.0.1:8642/health
curl -fS http://127.0.0.1:8642/v1/chat/completions \
  -H "Authorization: Bearer $HERMES_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"hermes-agent","messages":[{"role":"user","content":"안녕하세요. 짧게 답해주세요."}]}'
```

문제가 생기면 `kubectl -n mori logs deployment/mori-hermes-shared -c hermes`와 `kubectl -n mori describe pod -l app=mori-hermes-shared`로 이미지·PVC·노드 배치·모델 접속 오류를 확인한다. `/health`는 프로세스 확인용이며, llama.cpp까지 준비됐다는 보장은 아니다. 채팅 호출까지 성공해야 연결이 검증된다. [Hermes API 서버](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server).

## 공용 사용자 연결 범위

위 배포는 **공용 Gateway 한 개를 띄우는 단계**다. 초기 기본 profile로 연결을 시험할 수 있지만, 실제 무료 사용자 모두를 기본 profile에 넣으면 기억·세션·스킬이 섞인다. 여러 계정에 열기 전 계정별 Hermes profile과 profile별 `API_SERVER_KEY`·모델 키를 준비하고, Mori API가 로그인 계정을 `/p/<profile>/v1/...`에 서버 측에서 매핑해야 한다. 현재 `master`에는 이 Adapter와 자동 profile 생성기가 없다. Hermes profile은 파일·터미널 실행의 보안 경계가 아니므로 해당 도구는 사용자별로 격리하거나 제한해야 한다. [다중 profile Gateway](https://hermes-agent.nousresearch.com/docs/user-guide/multi-profile-gateways), [Hermes profile](https://hermes-agent.nousresearch.com/docs/user-guide/profiles/).
