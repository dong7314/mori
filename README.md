# Mori

휴대폰·태블릿에서 쓰는 개인 비서 서비스다.

- `master`: 실제 서비스 구현. 네이버·카카오 소셜 가입·로그인과 사용자별 주차 저장·조회 API.
- `poc`: HTML·JavaScript·SCSS 화면 실험.
- `plan`: 제품·아키텍처·프론트·백엔드 설계.

## 현재 구현

- FastAPI + PostgreSQL, Alembic 마이그레이션.
- 네이버 또는 카카오 인증을 완료한 계정만 가입. 일반 회원가입·수동 사용자 생성·수동 토큰 발급 경로 없음.
- 일회용 로그인 코드 교환, 액세스·갱신 토큰, 세션별 로그아웃, 내 정보 조회.
- `POST /v1/parking-records`: 주차 위치 저장, 재전송·동시 요청 중복 방지.
- `GET /v1/parking-records/latest`: 내 최신 주차 위치 조회.
- OpenAPI 계약, PostgreSQL 통합 테스트, Docker·Compose, k3s 배포 예시.

자연어 입력·Hermes·llama.cpp 연동은 다음 단계다. 현재 주차 API는 구조화된 위치를 받는다.

## 로컬 실행

```sh
cp .env.example .env
# .env에 소셜 앱 키와 콜백 주소를 설정한 뒤 실행한다.
docker-compose up --build -d
```

환경에 따라 `docker-compose` 대신 `docker compose`를 사용한다. API는 `http://localhost:8000`, Swagger UI는 `http://localhost:8000/docs`다. DB 자격 증명은 로컬 개발 전용이며 API·DB 포트는 루프백에만 공개한다. 키를 설정하지 않아도 서버는 시작하지만 해당 소셜 로그인은 비활성화된다.

[소셜 로그인·프론트 연결](backend/docs/social-login.md), [백엔드 실행·테스트](backend/README.md), [주차 API](backend/docs/parking-api.md), [OpenAPI JSON](backend/docs/openapi.json), [k3s 배포](infra/k3s/README.md)를 참고한다.
