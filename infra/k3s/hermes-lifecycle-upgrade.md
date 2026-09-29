# Hermes 0.1.1 시작·종료 수정 적용

현재 0.1.0 + 임시 foreground Knative 서비스에서 사용자 실측 11.69초/11.19초의 인증 API 콜드 스타트가 성공했다. 종료 결과는 hermes=1, queue-proxy=0이었다. Hermes는 bare SIGTERM을 계획되지 않은 종료로 분류하여 서비스 관리자 재기동을 위해 1을 반환한다. 준비 전 connection refused는 이후 Ready/API 성공과 구분한다.

0.1.1은 실제 dumb-init으로 orphan 정리·신호 전달을 담당하고, 공식 stage2/main-wrapper로 초기화·uid 10000 실행을 유지한다. s6 reconciler는 실행하지 않는다. TERM→INT 변환은 이 고정 Hermes의 계획된 종료 경로를 사용하며, 전체 종료 코드를 0으로 덮지 않는다. 근거: 이미지 내부 `gateway/run.py`의 signal handler, `gateway/run_shutdown.py`의 `_resolve_gateway_exit_verdict`, [dumb-init signal rewriting](https://github.com/Yelp/dumb-init#signal-rewriting).

테스트 범위: 네트워크 없는 로컬 amd64 컨테이너(Colima emulation), 같은 볼륨 3회 시작, TERM 종료, 강제 KILL 후 복구, 파일 marker 보존, 인증/도구 준비 검사. 실제 Knative 배포·LLM 호출·진행 중 cron/문서/추론 보존은 서버에서 별도 검증한다. 이미지 교체는 runtime이 유휴 상태일 때만 한다.

## 로컬 검증 결과 — 2026-09-29

- `mori-hermes:0.1.1` linux/amd64 빌드 완료. 당시 image index digest: `sha256:c945aa64c90df8cc2b50952d2a6ee4a6f0bbed572fc834760e34652a6751b5ea`. 재빌드하면 달라질 수 있으므로 실제 Harbor push/inspect 결과를 사용한다.
- unit 검사 67개, Ruff, YAML 참조 검사 통과.
- `check_image.py --image mori-hermes:0.1.1 --documents` 통과: 실제 gateway 3회 기동, TERM 코드 0 두 번, KILL 코드 137 및 다음 기동 성공, 파일 보존, 단일 uid 10000 gateway, 실패 코드 23 보존.
- DOCX/XLSX/PDF 생성·읽기·편집·원본 보존, 인증/도구 준비 검사 통과. 로컬 임시 volume/container 정리 완료.
- 이 기록 시점에 새 이미지 Harbor 업로드 및 홈 k3s 종료 코드 0 확인은 아직 수행하지 않았다.

## 1. Mac: 빌드·검증·Harbor 업로드

```sh
cd /Users/ldong-yeop/Desktop/private/mori-master
docker build --platform linux/amd64 -t mori-hermes:0.1.1 hermes
python3 scripts/runtime/check_image.py --image mori-hermes:0.1.1 --documents
docker tag mori-hermes:0.1.1 harbor.ldy-studio.com/mori/mori-hermes:0.1.1
docker push harbor.ldy-studio.com/mori/mori-hermes:0.1.1
docker buildx imagetools inspect harbor.ldy-studio.com/mori/mori-hermes:0.1.1
```

이미 같은 이미지의 빌드와 검증을 완료했다면 tag/push부터 진행한다. 기존 0.1.0 태그를 덮어쓰지 않는다. inspect의 최상단 Digest를 다음 단계에 사용한다. SearXNG는 변경하지 않는다.

## 2. k3s master: 교체 파일 준비 (기존 Knative Service가 있을 때)

저장소에 변경이 게시된 뒤 서버에서 갱신한다. 작업 트리에 본인 변경이 있으면 먼저 보존하며 reset하지 않는다.

```sh
cd /home/dongyeop/바탕화면/mori/mori-infra
git status --short
git pull --ff-only origin master
# 아래 sha256 부분은 Harbor inspect에서 확인한 새 Digest로 채운다.
MORI_HERMES_IMAGE='harbor.ldy-studio.com/mori/mori-hermes@sha256:새로운_64자리_digest'
python3 scripts/runtime/prepare_knative_upgrade.py --image "$MORI_HERMES_IMAGE"
```

생성기는 현재 서비스의 PVC/Secret 참조·배치·자원 설정을 보존하고 init/main 이미지를 함께 바꾼다. 임시 `/bin/sh -ec ...` command를 제거하여 새 이미지 ENTRYPOINT가 실행되게 한다. 아직 클러스터는 변경하지 않는다. 생성된 `.local/knative/hermes-service-upgrade.json`을 기존 서비스 위에 바로 apply하지 않는다. 동일 PVC를 쓰는 이전 Revision과 새 Revision이 겹칠 수 있다.

## 3. k3s master: 이전 작성자 종료 후 교체

각 명령이 성공해야 다음 명령으로 넘어간다. 자동화/다른 터미널에서 기존 Deployment를 켜거나 서비스를 재적용하지 않는다.

```sh
sudo k3s kubectl -n mori delete ksvc mori-hermes-knative \
  --cascade=foreground --timeout=300s
python3 scripts/smoke/knative.py --mode check-stopped
```

`PASS: source replicas=0; no Pod references Hermes PVC` 확인 후:

```sh
sudo k3s kubectl -n mori patch deployment mori-hermes-shared \
  --type=strategic --patch-file .local/knative/deployment-image-patch.json
sudo k3s kubectl apply --dry-run=server -f .local/knative/hermes-service-upgrade.json
sudo k3s kubectl apply -f .local/knative/hermes-service-upgrade.json
sudo k3s kubectl -n mori wait --for=condition=Ready \
  ksvc/mori-hermes-knative --timeout=180s
python3 scripts/smoke/knative.py --mode health
```

Deployment 패치는 replicas=0을 유지하고 향후 복구용 이미지도 수정한다. PVC/Secret/ConfigMap은 삭제하지 않는다. 기존 보조 client Pod는 gateway를 실행하지 않으므로 이전 이미지로 검사해도 된다. client가 하루 만료로 Completed이거나 없으면 기존 client.json으로 client Pod만 삭제·재생성한다.

```sh
# client가 없거나 Completed일 때만 실행
sudo k3s kubectl -n mori delete pod mori-hermes-coldstart-client --ignore-not-found
sudo k3s kubectl apply -f .local/knative/client.json
sudo k3s kubectl -n mori wait --for=condition=Ready \
  pod/mori-hermes-coldstart-client --timeout=180s
```

## 4. k3s master: 종료 코드와 재기동 확인

Ready 직후 다음 watch를 실행하고 추가 HTTP 요청 없이 자동 축소를 기다린다.

```sh
sudo k3s kubectl -n mori get pods \
  -l serving.knative.dev/service=mori-hermes-knative -w \
  -o 'custom-columns=NAME:.metadata.name,CONTAINERS:.status.containerStatuses[*].name,REASONS:.status.containerStatuses[*].state.terminated.reason,EXIT_CODES:.status.containerStatuses[*].state.terminated.exitCode'
```

기대 결과는 hermes,queue-proxy의 종료 코드 `0,0`. 삭제까지 확인하고 Ctrl+C 후:

```sh
python3 scripts/smoke/knative.py --mode health --require-zero
# 이전 실험에서 marker-create로 기준 파일을 만든 경우
python3 scripts/smoke/knative.py --mode marker-check
```

다시 자동 축소 후 실제 모델 호출을 확인한다.

```sh
python3 scripts/smoke/knative.py --mode search --require-zero
```

실패하면 연속 재요청하거나 기존 Deployment를 켜지 말고 현재 Pod의 hermes/queue-proxy 로그와 종료 코드를 수집한다. image pull/Ready 오류는 이번 종료 코드 문제와 구분한다. 정상 종료·저장 보존·0→1 요청 성공이 모두 확인된 뒤에만 현장 검증 완료로 기록한다.
