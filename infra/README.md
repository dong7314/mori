# Mori 인프라

Compose, Kubernetes 배포 설정과 운영 스크립트를 이 폴더에서 관리한다. API와 Hermes 이미지 소스는 [backend/](../backend/README.md), 제품 화면은 [frontend/](../frontend/)에 둔다.

| 경로 | 용도 |
| --- | --- |
| `compose.yaml` | 로컬 PostgreSQL·migration·API·선택 worker 실행 |
| `.env.example` / `.env` | Compose 설정 예시 / Git에서 제외한 실제 로컬 설정 |
| [k3s/](k3s/README.md) | API·worker·Hermes·SearXNG Kubernetes 배포 가이드와 매니페스트 |
| `scripts/runtime/` | 런타임 이미지 검사·Secret 준비·매니페스트 생성·검증 |
| `scripts/smoke/` | 배포한 서비스의 검색·추출·콜드 스타트 검사 |
| `.local/` | Git에서 제외한 생성 매니페스트·검사 환경 |

Compose 명령은 저장소 루트에서 실행한다.

```sh
cp infra/.env.example infra/.env
# infra/.env에 필요한 로컬 설정을 넣는다.
docker compose -f infra/compose.yaml up -d --build
docker compose -f infra/compose.yaml ps
```

Compose는 `infra/.env`를 읽고 프로젝트 이름을 `mori-master`로 유지한다. 기존 PostgreSQL 볼륨은 계속 사용한다. 로컬 Python 실행은 별도로 `backend/.env`를 사용한다. 자세한 실행·인증 안내는 [백엔드 README](../backend/README.md)를 따른다.

운영 스크립트도 저장소 루트에서 `python3 infra/scripts/runtime/...` 또는 `python3 infra/scripts/smoke/...`로 실행한다. 생성 결과는 `infra/.local/`, 백엔드 검증 결과는 `backend/output/`에 둔다. Hermes 이미지 빌드 경로는 `backend/hermes/`이며 [런타임 배포 절차](k3s/hermes-shared.md)에 명령을 정리했다.
