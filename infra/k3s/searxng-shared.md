# GitHub에서 공용 SearXNG 배포

배포 원본·스크립트는 이 저장소의 `master`에서 관리하고, 비밀 값은 서버의 Kubernetes Secret에만 둔다. 별도 ZIP 전송, 커스텀 SearXNG 이미지, Hermes 이미지 digest, GPU 키가 필요하지 않다. Python 3 표준 라이브러리와 `k3s kubectl`만 사용한다.

## 구성

- Namespace: `search`; Deployment/Service: `searxng`.
- 공식 이미지 digest는 `base/searxng/deployment.yaml`에서 고정한다.
- 실제 실행 노드: amd64 `k3s-infra`; `infra=true:NoSchedule` 허용.
- 일반 검색: Google/Naver/Brave. 이미지: Google/Naver. HTML/JSON, 한국어 기본.
- 내부 주소: `http://searxng.search.svc.cluster.local:8080`.
- ClusterIP이며 외부 공개용 Ingress는 만들지 않는다. 다른 namespace의 서비스도 네트워크 정책이 허용하면 이 주소로 호출할 수 있다.
- 사용자 기억·검색 기록은 호출하는 서비스가 관리한다. 본문 추출은 SearXNG의 역할이 아니며 현재 Hermes의 `mori-local` 제공자가 담당한다.
- requests 250m/512Mi, limits 1 CPU/1Gi는 시작값이다. 동시 호출량을 측정해 조정한다.

기존 `mori-tools` 테스트 리소스는 사용자가 삭제한 상태를 기준으로 한다. 이 배포는 이전 namespace 리소스를 자동 삭제하지 않는다. 이전 ZIP의 `search/searxng`를 이미 적용했다면 같은 이름의 리소스를 갱신하며 기존 Secret을 재사용한다. 구형 `mori-tools` 구성은 함께 배포하지 않는다.

## 1. 소스 받기 — k3s master

아래 명령은 모두 **k3s master에서** 실행한다. worker는 명령을 직접 실행하는 대상이 아니다.

```sh
cd /home/dongyeop
git clone --branch master --single-branch https://github.com/dong7314/mori.git mori-infra
cd mori-infra
git rev-parse HEAD
```

저장소가 비공개라면 서버에 설정한 GitHub SSH 인증 또는 HTTPS 자격증명 관리자를 사용한다. 토큰을 URL이나 파일에 넣지 않는다. 이미 `mori-infra`가 있으면 다시 clone하지 말고 먼저 `git status --short`와 `git branch --show-current`로 수정 여부/브랜치를 확인한다. 깨끗한 master에서만 `git pull --ff-only origin master`를 실행한다. 로컬 수정은 덮어쓰지 않는다.

## 2. Namespace와 서버 전용 Secret

```sh
sudo k3s kubectl apply -f infra/k3s/base/searxng/namespace.yaml
python3 scripts/runtime/create_secrets.py --component searxng
```

`search/searxng-secret`의 `SEARXNG_SECRET`을 난수로 생성한다. 값은 출력하거나 로컬 파일에 저장하지 않는다. 정상 Secret이 있으면 변경하지 않고 재사용한다. SearXNG 전용 모드에서는 GPU 키/Harbor 인증을 묻지 않는다.

Secret은 Kubernetes에 저장되는 값이다. Git에서 제외하는 것이 etcd 암호화나 접근 통제를 대신하지는 않는다. `kubectl get secret -o yaml` 출력도 Git에 올리지 않는다.

## 3. YAML 생성 및 적용

```sh
python3 scripts/runtime/configure.py --component searxng
sudo k3s kubectl apply --dry-run=server -f .local/manifests/searxng.yaml
sudo k3s kubectl apply -f .local/manifests/searxng.yaml
sudo k3s kubectl -n search rollout status deployment/searxng --timeout=300s
sudo k3s kubectl -n search get pods,svc -o wide
```

생성 YAML에는 ConfigMap·Deployment·Service만 있다. `.local/`은 Git 제외 경로이며 원본은 `infra/k3s/base/searxng/`이다. 다른 컴포넌트의 생성물이 있을 수 있으므로 `.local/manifests/` 전체를 apply하지 않는다.

이전 ZIP 구성 또는 기존 배포의 설정을 갱신하는 경우, 고정 ConfigMap을 시작 시 복사하므로 apply 후 재시작도 실행한다. 첫 설치에는 불필요하다.

```sh
sudo k3s kubectl -n search rollout restart deployment/searxng
sudo k3s kubectl -n search rollout status deployment/searxng --timeout=300s
```

Pod가 준비되지 않으면 다음으로 원인을 확인한다.

```sh
sudo k3s kubectl -n search get pods -o wide
sudo k3s kubectl -n search describe deployment searxng
sudo k3s kubectl -n search get events --sort-by=.lastTimestamp
sudo k3s kubectl -n search logs deployment/searxng -c searxng --tail=100
```

## 4. 검색 검사 — 포트포워딩 없이

```sh
python3 scripts/smoke/searxng.py --query '국립중앙박물관'
python3 scripts/smoke/searxng.py --mode images --engine google --query '경복궁 전경'
python3 scripts/smoke/searxng.py --mode images --engine naver --query '경복궁 전경'
sudo k3s kubectl -n search top pods --containers
```

검사 스크립트는 master에서 실행하고 실제 HTTP 요청은 SearXNG Pod에서 서비스 DNS를 통해 전송한다. 실패 엔진이 있으면 결과가 있어도 `DEGRADED`와 종료 코드 1을 반환한다. 유효 URL이 없는 결과도 성공 처리하지 않는다. 검색 품질·이미지 실제 로딩·Hermes 모델 도구 호출은 이 검사로 증명하지 않는다. CAPTCHA/제한은 설정 오류와 구분해서 확인한다.

## 5. Git 업데이트로 운영

```sh
git status --short
git pull --ff-only origin master
python3 scripts/runtime/configure.py --component searxng
sudo k3s kubectl diff -f .local/manifests/searxng.yaml
```

`diff` 종료 코드 1은 변경점이 있다는 뜻이다. 차이를 검토한 다음 apply하고 설정이 바뀌었다면 rollout restart한다. `create_secrets.py`를 반복 실행해도 정상 Secret은 회전하지 않는다. 소스 설정 변경은 Git에서 수정·커밋하고 서버에서는 pull한다. Secret 값을 바꿀 때는 서버에서 갱신 후 해당 Deployment를 재시작한다.

## 다음 단계: Hermes

[Hermes 배포 안내](hermes-shared.md)를 따른다. `SEARXNG_URL`은 이미 공용 `search` 주소로 맞췄다. Hermes만 준비하려면 두 스크립트에 `--component hermes`를 사용한다. 이 단계는 검색 서비스만 배포하며 Mori API·Hermes·Knative는 자동 적용하지 않는다.

Harbor 업로드의 60초 중단을 완화한 [Traefik 설정](platform/traefik-config.yaml)도 원본으로 보관한다. 이미 적용한 서버에서 재적용할 필요는 없다. 새 클러스터에서는 기존 HelmChartConfig와 병합해 사용한다. HTTPS 진입점 전체의 요청 수신 제한을 600초로 바꾸므로 Harbor 전용 설정이 아니다.
