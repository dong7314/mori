# 기존 k3s에 Mori API 배포

이 디렉터리는 배포 예시다. 기존 GPU·Hermes·클러스터를 수정하지 않는다. 실제 적용 전에 이미지 저장소, PostgreSQL 연결 주소, 소셜 앱 키와 공개 API 주소를 준비한다. PostgreSQL 배포·스토리지 정책은 별도로 구성한다.

## 적용 순서

1. `backend/Dockerfile`로 노드 아키텍처에 맞는 이미지를 빌드하고 접근 가능한 레지스트리에 올린다. 배포 파일 두 곳의 `mori-backend:dev`를 같은 배포 태그나 digest로 바꾼다.
2. `mori` namespace와 Mori용 PostgreSQL DB·접속 계정을 준비한다.
3. 아래 인증 설정과 DB 연결 문자열을 가진 `mori-backend` Secret을 만든다. 실제 값은 Git에 넣지 않는다.
4. 이전 버전이 실행 중이라면 전환 동안 트래픽을 중단하고 이전 API를 내린다. `migrate.yaml`의 Job 성공 후 새 API를 시작한다. 기존 수동 토큰은 폐기된다.
5. `backend.yaml`을 적용하고 readiness를 확인한다. TLS Ingress와 개발자 콘솔 콜백을 설정한 뒤 실제 소셜 로그인을 확인한다.

운영 설정 파일에는 다음 키를 준비한다. API의 모든 설정은 Secret에서 환경 변수로 읽는다. 마이그레이션 Job은 DB 연결 문자열만 읽는다.

```dotenv
MORI_DATABASE_URL=postgresql+psycopg://mori:REPLACE_PASSWORD@REPLACE_DB_HOST:5432/mori
MORI_AUTH_PUBLIC_BASE_URL=https://api.mori.example
MORI_AUTH_RETURN_URLS=["https://mori.example/auth/callback","mori://auth/callback"]
MORI_CORS_ORIGINS=["https://mori.example"]
MORI_AUTH_COOKIE_SECURE=true
MORI_NAVER_CLIENT_ID=REPLACE_NAVER_CLIENT_ID
MORI_NAVER_CLIENT_SECRET=REPLACE_NAVER_CLIENT_SECRET
MORI_KAKAO_CLIENT_ID=REPLACE_KAKAO_REST_API_KEY
MORI_KAKAO_CLIENT_SECRET=REPLACE_KAKAO_CLIENT_SECRET
```

위 값은 형식 예시다. Git에서 제외한 운영 전용 `backend/.env.production`에 실제 값을 넣고 다음과 같이 적용한다. `--from-env-file`에는 dotenv의 외부 따옴표 없이 값을 적는다. 소셜 제공자 콘솔 등록은 [소셜 로그인 문서](../../backend/docs/social-login.md)를 따른다.

```sh
kubectl create namespace mori
kubectl -n mori create secret generic mori-backend --from-env-file=backend/.env.production
kubectl apply -f infra/k3s/migrate.yaml
kubectl -n mori wait --for=condition=complete job/mori-migrate-0003 --timeout=120s
kubectl apply -f infra/k3s/backend.yaml
kubectl -n mori rollout status deployment/mori-api
kubectl -n mori port-forward service/mori-api 8000:8000
```

기존 Secret은 운영 환경의 Secret 관리 절차로 갱신한 뒤 Deployment를 재시작한다. 마이그레이션이 실패하면 새 API를 시작하지 않는다. 다음 릴리스는 Job 이름을 바꾸고 동시 마이그레이션을 실행하지 않는다. 모든 Pod의 시작 명령에 마이그레이션을 붙이지 않는다.

`0002_social_login`은 기존 사용자·주차 기록을 보존하지만 신규 소셜 계정과 자동 연결하지 않는다. 이전 수동 사용자·토큰 발급 명령은 제거되었다. DB 백업과 인증 데이터는 Pod 수명과 분리한다.

`0003_pro_access`는 기존 소셜 세션을 유지하며 모든 사용자에게 기본 무료 등급을 추가한다. 운영자가 먼저 소셜 가입한 다음 `/v1/me`의 ID로 `kubectl -n mori exec deployment/mori-api -- mori grant-super-admin --user-id <USER_UUID> --reason "최초 운영 관리자 지정"`을 실행한다. 이후 프로 승인은 최고 관리자 토큰으로 API에서 처리한다. [프로 승인 운영 문서](../../backend/docs/pro-access.md)를 참고한다.

## 운영 설정

- API는 무상태이며 복제본 1개로 시작한다. OAuth 요청·코드·세션은 PostgreSQL에 있으므로 API Pod가 바뀌어도 같은 인증 상태를 사용한다.
- CPU·메모리는 시작용 예시이며 실제 부하에서 조정한다. API에는 Kubernetes 관리 권한을 부여하지 않는다.
- readiness는 DB·스키마 접근, liveness는 프로세스를 확인한다. OAuth 키 검증은 readiness 대상이 아니다.
- Service는 내부용이다. 공개 API origin은 TLS Ingress 주소이며 `/v1`을 루트 경로에서 제공해야 한다. 호스트·콜백 주소는 서버 설정에서 고정한다.
- Uvicorn access log는 기본 비활성화다. Ingress·프론트 호스팅·APM에서도 OAuth 콜백의 전체 쿼리와 인증 본문·헤더를 기록하지 않도록 설정한다. 공개 인증 경로의 요청 제한은 Ingress에서 적용한다.
- `mori prune-auth`를 운영 스케줄러에서 주기적으로 실행해 만료된 인증 데이터를 정리한다. 예: `kubectl -n mori exec deployment/mori-api -- mori prune-auth`.
- 운영 시 마이그레이션 계정과 API의 제한된 DML 계정을 분리하면 Job과 Deployment가 각각 다른 Secret을 참조하도록 바꾼다.

실제 클러스터 배포와 실제 소셜 계정 검증은 아직 수행하지 않았다. Hermes Pod·에이전트 전용 인증·작업 큐는 다음 구현 범위다.
