# Mori

휴대폰·태블릿에서 쓰는 개인 비서 서비스다. 제품 코드는 `master`, 화면 실험은 `poc`, 제품·아키텍처 계획은 `plan` 브랜치에서 관리한다.

## 디렉터리

| 위치 | 역할 |
| --- | --- |
| [`backend/`](backend/README.md) | FastAPI API, DB 마이그레이션, worker와 테스트 |
| [`backend/hermes/`](backend/hermes/README.md) | AI 에이전트 이미지, 플러그인, 실행 검사 |
| [`frontend/`](frontend/README.md) | 사용자가 직접 개발할 React 웹과 후속 RN 앱 |
| [`infra/`](infra/README.md) | 로컬 Compose, Kubernetes 배포 설정과 운영 스크립트 |

최상단에는 이 세 영역과 저장소 안내·Git 설정만 둔다. GitHub Actions는 GitHub가 인식하는 `.github/workflows/`에 유지한다.

로컬 실행 설정은 `infra/.env`, 생성한 배포 YAML과 로컬 도구는 `infra/.local/`, 백엔드 검증 로그는 `backend/output/`에 둔다. 이 파일들은 Git에서 제외한다. Python으로 API를 직접 실행할 때 쓰는 설정은 `backend/.env`다.

## 로컬 실행

저장소 루트에서 실행한다. 최초 설정 시 `infra/.env.example`을 `infra/.env`로 복사하고 소셜 앱 키와 콜백 주소를 설정한다. 기존 `.env`가 있으면 그대로 사용한다.

```powershell
if (!(Test-Path infra/.env)) {
    Copy-Item infra/.env.example infra/.env
}
docker compose -f infra/compose.yaml up --build -d
docker compose -f infra/compose.yaml ps
```

독립 실행 파일을 사용하는 환경에서는 `docker compose`를 `docker-compose`로 바꾼다. Compose는 `infra/.env`를 읽는다. 기본 프로젝트 이름 `mori-master`를 유지해 디렉터리 이동 전의 DB 볼륨을 계속 사용한다. 기존에 `-p` 또는 `COMPOSE_PROJECT_NAME`을 사용했다면 같은 값을 유지한다.

기본 API는 `http://localhost:8000`, Swagger UI는 `http://localhost:8000/docs`다. API·DB 포트는 루프백에만 공개한다. 종료 명령은 `docker compose -f infra/compose.yaml down`이며, DB 데이터는 볼륨에 남는다.

## 구현과 계약

현재 백엔드 계약은 [API 0.9 안내](backend/docs/poc-backend-0.9.md)와 [OpenAPI](backend/docs/openapi.json)를 따른다. 소셜 로그인·계정, 주차·기록·일정·기능, 채팅 작업과 SSE, 문서 작업, 예약·알림·외부 서비스 연결 코드를 포함한다. 외부 공급자 설정과 worker 실행, 실제 서비스 배포·기기 검증은 별도로 진행한다.

- [백엔드 실행·검사](backend/README.md)
- [소셜 로그인과 프론트 연결](backend/docs/social-login.md)
- [화면별 API 대응](backend/docs/poc-parity-map-0.9.md)
- [인프라 구성과 배포](infra/README.md)
