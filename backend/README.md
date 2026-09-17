# Mori Backend

첫 구현 범위는 인증된 사용자의 주차 기록 저장·최신 조회다. Hermes와 자연어 대화는 아직 연결하지 않았다. 기존 Qwen·k3s 환경을 바꾸지 않으며 이 API가 이후 Hermes 도구의 저장 경로가 된다.

## 실행 환경

- Python 3.12 또는 3.13, PostgreSQL 16 이상.
- `uv.lock`으로 실행·개발 의존성을 고정한다. 개발·CI·이미지 빌드는 uv 0.12.15 기준이다.
- DB 스키마는 Alembic으로 적용한다. API 시작 시 테이블을 자동 생성하지 않는다.

## Docker로 실행

저장소 루트에서 실행한다. CLI 플러그인 환경에서는 `docker compose`로 바꿔 실행한다.

```sh
docker-compose up --build -d
docker-compose ps
curl --fail http://127.0.0.1:8000/health/ready
docker-compose exec api mori create-user --name "개인 알파"
```

DB 준비 → 마이그레이션 성공 → API 시작 순서다. 발급 명령은 `user_id`, `token_id`, `access_token`, `expires_at`을 한 번 출력한다. 토큰은 Swagger UI의 Authorize 또는 `Authorization: Bearer ...` 헤더에 넣는다. Git·채팅·애플리케이션 로그에 토큰을 남기지 않는다.

기본 주소는 API `127.0.0.1:8000`, PostgreSQL `127.0.0.1:55432`다. 충돌하면 `MORI_API_PORT`, `MORI_DB_PORT` 환경 변수로 바꾼다. DB 데이터는 Compose 볼륨에 남으며, `docker-compose down`은 볼륨을 삭제하지 않는다. `down -v`는 저장 데이터를 삭제하므로 평소 종료에 사용하지 않는다.

## Python으로 개발

```sh
# 저장소 루트에서 로컬 PostgreSQL 시작
docker-compose up -d --wait db
cd backend
cp .env.example .env
uv sync --frozen
uv run alembic upgrade head
uv run mori create-user --name "개인 알파"
uv run uvicorn mori.main:create_app --factory --reload --host 127.0.0.1 --port 8000
```

`MORI_DATABASE_URL`은 `postgresql+psycopg://` 연결 문자열이어야 한다. 비밀번호에 URI 예약 문자가 있으면 percent-encoding한다. `MORI_CORS_ORIGINS`는 정확한 프론트 origin의 JSON 배열이다. 기본값은 빈 배열이며 `*`는 허용하지 않는다. 개발용 `.env`와 운영 Secret은 커밋하지 않는다.

## 개인 알파 인증

소셜 로그인·회원가입은 이번 범위에 포함하지 않는다. 운영자가 신뢰할 수 있는 서버 터미널에서 사용자를 만들고 고엔트로피 토큰을 발급하는 방식이다. 외부에 API를 공개할 때는 HTTPS를 사용한다. 토큰 원문은 DB에 저장하지 않고 SHA-256 해시만 저장한다. 유효 기간은 기본 30일이며 발급 시 `--token-days`로 1~365일을 지정한다.

```sh
uv run mori issue-token --user-id <USER_UUID> --token-days 7
uv run mori revoke-token --token-id <TOKEN_UUID>
```

새 토큰 발급만으로 기존 토큰은 폐기되지 않는다. 교체 완료 후 기존 `token_id`를 명시적으로 폐기한다. 사용자 ID는 인증 토큰에서 서버가 결정하며 body·query·`X-User-ID`로 변경할 수 없다. 나중에 로그인 시스템을 연결할 때도 주차 저장 로직은 같은 사용자 ID를 사용한다. Hermes용 작업 범위 인증은 해당 연동 단계에서 추가한다.

## API와 데이터

[프론트 계약과 curl 예시](docs/parking-api.md), [OpenAPI JSON](docs/openapi.json).

- 사용자·토큰·주차 기록을 PostgreSQL에 보관한다.
- 위치의 층·구역·자리 번호 중 하나 이상이 있어야 한다. 앞뒤 공백을 제거하며 위치 명칭은 임의로 변환하지 않는다.
- 기록 시각은 DB가 생성하고 UTC로 반환한다. 현재는 실제 주차 시각을 과거 날짜로 지정하는 기능이 없다.
- 최신 기록은 서버 기록 시각, 동률이면 UUID 내림차순으로 결정한다. 같은 요청의 재전송은 새 기록을 만들거나 기록 시각을 갱신하지 않는다.
- 멱등 키는 사용자별 UUID이며 기록이 보존되는 동안 유효하다. 정규화한 내용이 같으면 원래 결과를, 다르면 `409`를 반환한다. 같은 내용이어도 새 키를 보내면 새로운 주차 기록이다.
- DB 쓰기가 commit된 뒤에만 저장 성공을 반환한다. 쓰기 결과를 받기 전에 연결이 끊겨도 같은 키로 재전송해 결과를 확인한다.
- 기록·인증 응답에 `Cache-Control: no-store`를 적용한다. DB 오류에 자격 증명·SQL·요청 원문을 반환하지 않는다.

모든 SQL 조회·쓰기에 서버가 결정한 사용자 범위를 적용한다. PostgreSQL RLS는 아직 적용하지 않았다. `/v1` 라우트의 인증·소유권 검사를 거치지 않는 에이전트 직접 DB 접근은 제공하지 않는다.

## 검증

테스트는 SQLite 대체품 없이 PostgreSQL에서 실행한다. 아래 URL은 개발·CI용 PostgreSQL을 지정하며 DB 생성 권한이 필요하다. 운영 DB 자격 증명을 사용하지 않는다. 테스트가 `mori_test_<무작위 UUID>` DB를 만들고 실제 마이그레이션을 적용한 뒤 종료 시 해당 DB만 삭제한다.

```sh
uv sync --frozen
uv run ruff check .
uv run ruff format --check .
MORI_TEST_POSTGRES_URL=postgresql+psycopg://mori:mori-local-only@127.0.0.1:55432/mori uv run pytest
uv run python scripts/export_openapi.py --check
```

검증 범위는 실제 저장·UTC 시각·앱 재생성 후 조회, 사용자 격리, 토큰 만료·폐기, 입력 검증, 순차·동시 재전송, 멱등 키 충돌, DB 장애, CORS, 마이그레이션과 모델 일치·롤백·재적용이다. 테스트용 PostgreSQL URL이 없으면 테스트를 건너뛰지 않고 실패시킨다.

API 계약 변경 시 다음 명령으로 문서를 갱신한다. DB 접속 없이 실행된다.

```sh
uv run python scripts/export_openapi.py
```

## 배포

`Dockerfile`은 의존성을 잠금 파일로 설치하고 UID 10001로 실행한다. `/health/live`는 프로세스, `/health/ready`는 DB와 기본 테이블 접근을 확인한다. DB 장애를 liveness 실패로 취급해 API를 계속 재시작하지 않는다.

[k3s 예시](../infra/k3s/README.md)는 API Deployment·내부 Service·별도 마이그레이션 Job을 제공한다. 실제 클러스터 접속·DB 생성·배포는 수행하지 않았다.
