# k3s master에서 임시 토큰으로 검색 API 테스트

프론트, 브라우저, 소셜 로그인, 가입된 계정 없이 검색 연동을 검사한다. 모든 명령은 **k3s master**에서 실행한다. 이 토큰은 Mori 검색 API용이며 Hermes의 `API_SERVER_KEY`와 다르다.

## 동작 범위

- 기본 `MORI_ASSISTANT_TEST_TOKEN_ENABLED=false`.
- 명시적으로 활성화하고 서버 Secret과 일치하는 `Authorization: Bearer mori_lab_...`를 보내면 **POST /v1/assistant/search만** 사용자 로그인·DB 토큰 검증을 생략한다.
- 테스트 계정 UUID, 네이버·카카오 앱 키가 필요 없다. 사용자·인증 세션·프로 권한을 생성하거나 변경하지 않는다.
- `/v1/me`, 주차, 관리자 API의 인증은 그대로다. 이 토큰으로 사용할 수 없다.
- 공용 Hermes의 검색 테스트용으로만 사용한다. 대화·파일·기억의 다중 사용자 격리 기능은 아니다. 테스트 중 Mori API는 ClusterIP와 master의 루프백 포트포워딩으로 접근한다.
- 회원 가입은 계속 네이버·카카오로만 가능하다. 나중에 테스트 모드를 끄면 이 임시 토큰은 거부되고 기존 로그인 경로만 남는다.

## 0. Mori API 배포 준비

현재 클러스터에 Hermes만 있다면 **먼저 이번 코드로 Mori API를 배포**해야 한다. 기존 Hermes를 재설치하지 않는다.

1. `master` 소스로 백엔드 이미지를 빌드해 Harbor에 올린다.
2. PostgreSQL, `MORI_DATABASE_URL`, `mori-backend` Secret을 준비한다. 소셜 앱 키는 이번 검사에 비워둘 수 있다.
3. `infra/k3s/migrate.yaml`, `backend.yaml`의 이미지를 실제 이미지 태그/digest로 맞춘다.
4. 마이그레이션 Job 성공 뒤 `mori-api`를 배포한다. 신규 DB에는 기존 마이그레이션이 모두 필요하다.

[기본 배포 절차](../../infra/k3s/README.md), [이미지 빌드 안내](assistant-search.md)를 참고한다. 임시 토큰 경로 자체는 DB 인증을 조회하지 않지만, **Mori API의 readiness는 DB·스키마를 확인하므로 정상적인 k3s Service 배포에는 PostgreSQL이 필요하다.** DB 설정을 가짜 주소로 채워 배포하지 않는다.

이후 명령은 master에 최신 소스를 준비한 뒤 **저장소 루트**에서 실행한다.

## 1. 임시 토큰 생성

```sh
python3 backend/scripts/create_assistant_test_token.py \
  --output /home/dongyeop/.mori-assistant-test-token
```

384비트 난수 기반 토큰을 권한 600 파일에 저장한다. 값은 터미널에 출력하지 않는다. 이미 파일이 있으면 덮어쓰지 않고 중단한다. 기존 테스트를 이어가면 원래 파일을 사용한다.

```sh
sudo k3s kubectl -n mori create secret generic mori-assistant-test \
  --from-file=MORI_ASSISTANT_TEST_TOKEN=/home/dongyeop/.mori-assistant-test-token
```

이미 같은 Secret이 있다면 자동 덮어쓰기하지 말고 현재 테스트에 사용한 토큰 파일인지 확인한다. 토큰 파일은 Git에 넣지 않는다.

## 2. Mori API에 임시 토큰 모드와 Hermes 연결 적용

```sh
sudo k3s kubectl -n mori patch deployment mori-api --type strategic \
  --patch-file infra/k3s/backend-hermes-test-token.patch.yaml

sudo k3s kubectl -n mori rollout status deployment/mori-api --timeout=300s
```

패치가 설정하는 값:

```text
MORI_ASSISTANT_TEST_TOKEN_ENABLED=true
MORI_ASSISTANT_TEST_TOKEN ← mori-assistant-test Secret
MORI_HERMES_BASE_URL=http://mori-hermes-shared.mori.svc.cluster.local:8642
MORI_HERMES_API_KEY ← 기존 mori-hermes Secret의 API_SERVER_KEY
MORI_HERMES_TIMEOUT_SECONDS=300
```

`MORI_HERMES_TEST_USER_ID`는 임시 토큰 경로에 필요 없다. 기존 소셜 로그인 경로용으로 설정되어 있어도 임시 토큰 경로에는 적용되지 않는다.

## 3. API 포트포워딩

**master 터미널 A**, 실행한 채 유지:

```sh
sudo k3s kubectl -n mori port-forward service/mori-api 8000:8000 --address=127.0.0.1
```

**master 터미널 B**, 저장소 루트에서:

```sh
curl --fail http://127.0.0.1:8000/health/ready

python3 backend/scripts/test_assistant_search.py \
  --test-token-file /home/dongyeop/.mori-assistant-test-token
```

스크립트는 파일에서 읽은 토큰을 Bearer 헤더에 넣는다. 토큰 값 복사, 로그인, 브라우저 실행은 필요 없다. 실제 검사 순서:

1. 토큰 없는 검색 요청 → HTTP 401.
2. 잘못된 임시 토큰 → HTTP 401.
3. 유효한 임시 토큰 → Mori API → Hermes → 검색·필요한 본문 추출.
4. 실제 web_search 성공 결과, 답변, 출처 반환 확인.

예상 마지막 출력:

```text
PASS: 임시 토큰 → Mori API → Hermes 검색 → 답변·출처 반환 확인
```

검색 및 모델 추론에 수 분 걸릴 수 있다. 테스트가 타임아웃됐다고 바로 반복하지 않는다. 서버의 타임아웃은 Hermes 작업 취소를 보장하지 않는다. 답변의 사실 정확성은 별도 대조한다.

## 4. 테스트 종료 후 임시 인증 비활성화

```sh
sudo k3s kubectl -n mori set env deployment/mori-api \
  MORI_ASSISTANT_TEST_TOKEN_ENABLED=false MORI_ASSISTANT_TEST_TOKEN-

sudo k3s kubectl -n mori rollout status deployment/mori-api --timeout=300s
```

Pod가 바뀌었으므로 터미널 A의 기존 포트포워딩을 Ctrl+C로 종료하고 3번 명령으로 다시 실행한다. 터미널 B에서:

```sh
python3 backend/scripts/test_assistant_search.py \
  --test-token-file /home/dongyeop/.mori-assistant-test-token --check-disabled
```

예상: `PASS: 임시 토큰 비활성화 확인 (HTTP 401)`. 이후 이 테스트용 Secret과 파일을 제거한다.

```sh
sudo k3s kubectl -n mori delete secret mori-assistant-test
rm /home/dongyeop/.mori-assistant-test-token
```

진행 중이던 요청까지 이 설정 변경으로 취소된다고 가정하지 않는다. 이후 토큰 경로 코드를 제거할 때는 `assistant/auth.py`의 임시 토큰 분기, Settings 항목 두 개, 관련 패치·스크립트·테스트를 제거하면 된다. 이번 설정 비활성화만으로도 새 임시 토큰 요청은 거부된다.

## 자동 검증

실제 PostgreSQL 기반 테스트에서 정상 임시 토큰, 비활성·틀린 토큰 거부, 다른 API 접근 거부, 사용자 생성 없음, 기존 소셜 인증 유지, 설정 오류, 토큰 파일 권한을 확인한다. DB 접속 불가능 환경에서도 임시 인증을 통한 검색 요청이 상류 모의 서버까지 도달하는 별도 검사로 로그인 DB 조회가 없음을 확인한다. 실제 k3s 통신은 위 배포 후 검사 대상이다.
