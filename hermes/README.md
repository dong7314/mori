# Mori Hermes image

[홈 k3s 배포 절차](../infra/k3s/hermes-shared.md)

공식 Hermes에 기존 현장 시험의 검색·본문 추출 도구와 문서 실행 환경을 포함한다. LLM 가중치, SearXNG 서버, 사용자 데이터는 이미지에 포함하지 않는다.

| 항목 | 고정 값/위치 |
| --- | --- |
| 공식 base | `nousresearch/hermes-agent@sha256:d43ac4ef5c76ec063342cd1cb1c1f839ce73acffa9445bee87bbccfd39ccb808` |
| base revision label | `9a7b54accf841127bacfaab74fa1d7d982bca9fa` |
| 현재 배포 플랫폼 | `linux/amd64`, k3s-infra |
| `mori_image_search` | `plugins/mori_images`, SearXNG Google/Naver 이미지 후보 검색 |
| `web_extract` provider | `plugins/mori_extract`, `mori-local`, Trafilatura 2.2.0 |
| 실행 코드 | `/opt/mori/plugins`, `/opt/mori/checks` |
| 추출 Python | `/opt/mori/extract-venv/bin/python` |
| 사용자 home | `/opt/data` PVC |

`bootstrap.py`는 같은 이미지의 init container에서 실행한다. ConfigMap을 home의 config로 원자적으로 교체하고 세 플러그인을 이미지 경로에 연결한다. 기존 같은 이름의 임의 디렉터리·다른 symlink는 덮어쓰지 않는다. 실행 중 패키지 설치는 필요 없다.

추출 worker는 공개 HTTP(S) HTML만 처리한다. DNS 결과·리다이렉트를 검증하고 검증한 IP로 연결한다. HTML 2MB, 추출 본문 100,000자, URL별 subprocess 25초, 호출당 최대 URL 3개로 제한한다. 브라우저 JS·PDF·이미지 픽셀 처리나 여행 경로 계산 기능은 없다. 이미지 검색도 URL 후보만 반환한다.

`requirements.lock`은 현장 시험의 Trafilatura와 하위 버전을 고정하고 파일 hash를 추가했다. 공식 base의 프로젝트 설정(`exclude-newer`)이 이 별도 환경에 간섭하지 않도록 uv의 `--no-config`를 사용한다. Hermes 본체 venv는 변경하지 않는다. 의존성 갱신 시 `requirements.in`으로 새 lock을 생성하고 diff와 회귀를 검토한다.

```sh
# 저장소 루트, Docker 사용 가능 환경. lock 갱신은 의도적인 의존성 변경이다.
docker run --rm --platform linux/amd64 \
  --mount "type=bind,src=$PWD/hermes,dst=/work" --workdir /work \
  --entrypoint uv \
  nousresearch/hermes-agent@sha256:d43ac4ef5c76ec063342cd1cb1c1f839ce73acffa9445bee87bbccfd39ccb808 \
  pip compile --no-config --generate-hashes --python-version 3.13 \
  --python-platform x86_64-unknown-linux-gnu requirements.in -o requirements.lock
```

`HERMES_GATEWAY_NO_SUPERVISE=1`은 고정 base에서 확인한 foreground 실행 옵션이다. 공식 s6 entrypoint의 초기화·권한 하강은 유지하고 gateway의 별도 동적 서비스 생성은 생략한다. Kubernetes가 컨테이너 종료/재시작을 관리한다.

## 검증 기록 — 2026-09-28

- 로컬 unit/fixture 검사 33개 통과: 이미지 엔진 지정·실패, 추출 주소/리다이렉트 제한, 실제 parser fixture, 호출 ID/간접 호출/출처, 초기화·상태 보존·설정 충돌, 이미지 digest 입력.
- Kubernetes v1.34.3의 Kustomize로 base와 로컬 registry overlay 렌더링·참조 검증 통과. init/main 이미지 일치, ConfigMap 해시 참조, namespace·worker 배치와 storage/Secret 분리를 확인했다.
- `linux/amd64` Docker 빌드 통과. 네트워크 없는 컨테이너에서 공식 entrypoint, 초기화 두 번, API health·도구 로딩·무인증/오인증 401·`mori-local` 제공자 선택 확인.
- SearXNG 고정 이미지에 실제 settings를 넣고 외부 네트워크 없이 다섯 내장 엔진 로딩·한국어 기본값·JSON 활성화를 확인했다.
- 실제 Harbor push, 홈 k3s 재배포, GPU 모델 호출, 외부 엔진 검색 결과와 사진 로딩은 이 로컬 검사에 포함하지 않았다. 재배포 후 master 검사 CLI로 확인한다.

이번 목적은 재현 가능한 개발 실행 환경이다. 공식 base의 불필요한 패키지를 제거한 경량 버전이나 다중 사용자 격리 구현은 아니다. 향후 base digest를 바꿀 때 provider/plugin API와 foreground 옵션까지 다시 검증한다.

## 문서 생성·편집 확장

Word·Excel·PDF 실행 환경과 `mori_document` 도구를 이미지에 포함한다. 기본 검색 설정에서는 비활성이며 신뢰된 단일 사용자에게만 명시적으로 노출한다. [지원 범위·활성화·검사](documents.md)를 따른다. HWP 원본 편집, LibreOffice 변환, 수식 재계산과 Mori 파일 API는 후속이다.
