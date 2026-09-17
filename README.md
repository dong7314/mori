# Mori

휴대폰·태블릿에서 쓰는 개인 비서 서비스의 실제 구현 브랜치다.

- `master`: 실제 서비스 구현. 현재 백엔드의 사용자별 주차 저장·조회 API.
- `poc`: HTML·JavaScript·SCSS 화면 실험.
- `plan`: 제품·아키텍처·프론트·백엔드 설계.

## 현재 구현

- FastAPI + PostgreSQL, Alembic 마이그레이션.
- 사용자별 만료·폐기 가능한 Bearer 토큰 인증. 개인 알파용 관리 CLI로 발급한다.
- `POST /v1/parking-records`: 주차 위치 저장, 재전송·동시 요청 중복 방지.
- `GET /v1/parking-records/latest`: 내 최신 주차 위치 조회.
- OpenAPI 계약, PostgreSQL 통합 테스트, Docker 이미지·Compose, k3s API 배포 예시.

자연어 입력·Hermes·llama.cpp 연동은 다음 단계다. 현재 API는 구조화된 위치를 받는다.

## 로컬 실행

```sh
docker-compose up --build -d
docker-compose exec api mori create-user --name "개인 알파"
```

환경에 따라 `docker-compose` 대신 `docker compose`를 사용한다. 로컬 API는 `http://127.0.0.1:8000`, Swagger UI는 `http://127.0.0.1:8000/docs`다. Compose의 DB 자격 증명은 로컬 개발 전용이며 API·DB 포트는 루프백에만 공개한다.

[백엔드 실행·인증·테스트](backend/README.md), [프론트 연동 계약](backend/docs/parking-api.md), [OpenAPI JSON](backend/docs/openapi.json), [k3s 배포](infra/k3s/README.md)를 참고한다.
