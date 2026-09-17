# Mori Backend

네이버·카카오 소셜 가입·로그인과 사용자별 주차 저장·조회를 제공한다. Hermes와 자연어 대화는 아직 연결하지 않았다. 주차 API가 이후 Hermes 도구의 저장 경로가 된다.

## 실행 환경

- Python 3.12 또는 3.13, PostgreSQL 16 이상.
- `uv.lock`으로 실행·개발 의존성을 고정한다. uv 0.12.15 기준이다.
- DB 스키마는 Alembic으로 적용한다. API 시작 시 테이블을 자동 생성하지 않는다.

## Docker로 실행

저장소 루트에서 실행한다. CLI 플러그인 환경에서는 `docker compose`로 바꿔 실행한다.

```sh
cp .env.example .env
# .env에 Naver/Kakao 앱 키와 콜백 주소 설정
# 개발자 콘솔 등록은 docs/social-login.md 참고
docker-compose up --build -d
docker-compose ps
curl --fail http://localhost:8000/health/ready
curl --fail http://localhost:8000/v1/auth/providers
```

DB 준비 → 마이그레이션 성공 → API 시작 순서다. 키가 없는 제공자는 `enabled: false`이며 로그인 시작 시 `503 SOCIAL_LOGIN_NOT_CONFIGURED`를 반환한다. 관리 CLI로 계정이나 토큰을 발급할 수 없다.

기본 주소는 API `localhost:8000`, PostgreSQL `127.0.0.1:55432`다. 충돌하면 `MORI_API_PORT`, `MORI_DB_PORT`를 바꾸고 공개 API 주소·개발자 콘솔 콜백도 같은 포트로 맞춘다. DB 데이터는 Compose 볼륨에 남는다. 평소 종료는 `docker-compose down`을 사용한다. `down -v`는 저장 데이터까지 삭제한다.

## Python으로 개발

```sh
# 저장소 루트에서 로컬 PostgreSQL 시작
docker-compose up -d --wait db
cd backend
cp .env.example .env
uv sync --frozen
uv run alembic upgrade head
uv run uvicorn mori.main:create_app --factory --reload --host 127.0.0.1 --port 8000 --no-access-log
```

Python 실행은 `backend/.env`, Compose는 루트 `.env`를 읽는다. 실제 키는 로컬 파일이나 운영 Secret에 설정하고 커밋하지 않는다. `MORI_DATABASE_URL`은 `postgresql+psycopg://` 연결 문자열이며 비밀번호의 URI 예약 문자는 percent-encoding한다. `MORI_CORS_ORIGINS`는 프론트 origin의 JSON 배열이다. 기본값은 빈 배열이며 `*`는 허용하지 않는다.

## 소셜 가입과 인증

[소셜 로그인 계약](docs/social-login.md)에 제공자 설정, 브라우저·앱 흐름, 요청·응답과 프론트 코드 예시를 정리했다.

- 서버가 네이버·카카오 코드를 교환하고 사용자 식별자를 확인한다. 로그인한 클라이언트가 일회용 Mori 코드와 원래 verifier를 교환하면 가입 또는 재로그인한다.
- 계정은 `(provider, subject)`로 구분한다. 이메일이 같아도 서로 다른 소셜 계정을 자동 병합하지 않는다.
- Mori 액세스 토큰은 기본 15분, 갱신 세션은 로그인 시점부터 최대 30일이다. 갱신할 때 토큰을 교체하며 사용한 갱신 토큰의 재사용은 해당 세션 전체를 폐기한다.
- PostgreSQL에는 Mori 토큰 해시만 보관한다. 소셜 제공자의 토큰·이메일·전화번호는 저장하지 않는다.
- 사용자 ID는 인증 문맥에서 결정한다. body·query·`X-User-ID`로 다른 사용자를 지정할 수 없다.

운영 CLI는 기존 세션 폐기와 만료 데이터 정리만 제공한다.

```sh
uv run mori revoke-session --session-id <SESSION_UUID>
uv run mori prune-auth
# Compose에서는 docker-compose exec api mori prune-auth
```

`prune-auth`는 만료된 로그인 요청·교환 코드·세션과 그 세션의 토큰을 제거한다. 운영 스케줄러에서 하루 한 번 등 주기적으로 실행한다. 활성 세션의 사용한 갱신 토큰은 재사용 감지를 위해 유지한다.

### 기존 알파 데이터의 전환

`0002_social_login`은 기존 사용자·주차 기록을 보존하고 기존 수동 액세스 토큰을 모두 폐기한다. 기존 알파 계정에는 확인된 소셜 식별자가 없으므로 신규 소셜 가입 계정과 자동 연결하지 않는다. 테스트 기록을 새 계정으로 옮기는 별도 이관 기능은 제공하지 않는다. 스키마를 되돌려도 토큰 폐기를 되돌리지 않으며, 다운그레이드 시 남아 있는 토큰도 폐기한다.

## API와 데이터

[주차 API 계약](docs/parking-api.md), [OpenAPI JSON](docs/openapi.json).

- 사용자·소셜 식별자·인증 세션·주차 기록을 PostgreSQL에 보관한다. API Pod가 재시작되거나 복제되어도 같은 DB의 인증 상태를 사용한다.
- 주차 위치의 층·구역·자리 번호 중 하나 이상이 필요하다. 앞뒤 공백을 제거하며 위치 명칭은 임의로 변환하지 않는다.
- 기록 시각은 DB가 생성하고 UTC로 반환한다. 최신 기록은 기록 시각, 동률이면 UUID 내림차순으로 결정한다.
- 사용자별 멱등 키는 기록이 보존되는 동안 유효하다. 정규화한 내용이 같으면 원래 결과, 다르면 `409`를 반환한다. 새 키는 새로운 기록이다.
- DB commit 후 성공을 반환한다. 주차 저장 응답이 유실되면 같은 키로 재전송한다. 인증 코드 교환은 한 번만 가능하므로 응답 유실 시 새 로그인을 시작한다.
- `/v1` 응답에 `Cache-Control: no-store`, `Referrer-Policy: no-referrer`를 적용한다. DB 오류에 자격 증명·SQL·요청 원문을 반환하지 않는다.

사용자 범위는 서버에서 검사한다. PostgreSQL RLS와 에이전트의 직접 DB 접근은 제공하지 않는다. Hermes용 작업 범위 인증은 연동 단계에서 추가한다.

## 검증

테스트는 실제 PostgreSQL에서 실행한다. 아래 URL은 DB 생성 권한이 있는 개발·CI용 서버를 지정한다. 테스트가 `mori_test_<무작위 UUID>` DB를 만들고 실제 마이그레이션을 적용한 뒤 해당 DB만 삭제한다. URL이 없으면 테스트를 건너뛰지 않고 실패한다.

```sh
uv sync --frozen
uv run ruff check .
uv run ruff format --check .
MORI_TEST_POSTGRES_URL=postgresql+psycopg://mori:mori-local-only@127.0.0.1:55432/mori uv run pytest
uv run python scripts/export_openapi.py --check
```

제공자 HTTP 응답만 MockTransport로 대체하고, OAuth 라우트·인증·세션·주차·동시 요청·마이그레이션은 실제 앱과 PostgreSQL로 검증한다. 실제 네이버·카카오 계정으로의 전체 로그인은 앱 키와 공개 콜백 설정 후 별도로 확인해야 한다.

API 계약을 바꾸면 `uv run python scripts/export_openapi.py`로 문서를 갱신한다. 이 명령은 DB에 연결하지 않는다.

## 배포

Docker 이미지는 UID 10001로 실행한다. `/health/live`는 프로세스, `/health/ready`는 DB와 스키마 접근을 확인한다. 기본 명령은 OAuth 콜백 코드가 URL 로그에 남지 않도록 Uvicorn access log를 끈다. Ingress·APM에서도 인증 요청의 쿼리·쿠키·본문·Authorization 헤더 수집을 제외한다.

[k3s 예시](../infra/k3s/README.md)는 API Deployment·내부 Service·별도 마이그레이션 Job을 제공한다. 실제 클러스터 배포는 수행하지 않았다.
