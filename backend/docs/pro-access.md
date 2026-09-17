# 무료·프로 권한과 최고 관리자 승인

가입자는 기본 무료 사용자다. 최고 관리자가 소셜 가입자를 직접 승인하면 프로 사용자가 되며, 승인을 회수하면 무료로 돌아간다. 현재는 요금제·결제·구독·유효 기간 없이 승인 상태만 관리한다. 별도의 프로 신청·심사 대기 목록은 없다.

## 등급과 역할

| 구분 | API 값 | 의미 |
| --- | --- | --- |
| 사용자 등급 | `tier: free` | 무료 사용자, 가입 시 기본값 |
| 사용자 등급 | `tier: pro` | 최고 관리자가 프로 사용을 승인한 사용자 |
| 운영 역할 | `role: user` | 일반 사용자, 가입 시 기본값 |
| 운영 역할 | `role: super_admin` | 사용자 조회와 프로 승인·회수가 가능한 최고 관리자 |

프로와 최고 관리자는 별개다. 프로 사용자가 다른 사람의 권한을 바꿀 수 없고, 최고 관리자로 지정되어도 프로 등급이 자동 부여되지는 않는다. 최고 관리자는 필요하면 자신의 프로 사용도 명시적으로 승인할 수 있다.

`GET /v1/me` 응답에 다음 필드가 추가된다.

```json
{
  "id": "사용자 UUID",
  "display_name": "모리 사용자",
  "providers": ["naver"],
  "tier": "free",
  "role": "user"
}
```

프론트에서는 `free`를 **무료**, `pro`를 **프로**로 표시한다. 관리자 화면 노출에는 `role`을 사용한다. 서버도 모든 관리자 요청에서 역할을 검사하므로 프론트 표시만 변경해서 권한을 얻을 수 없다. 사용자가 보내는 헤더·가입 요청으로 `tier`나 `role`을 지정하는 경로는 제공하지 않는다.

## 최초 최고 관리자 지정

1. 운영자도 먼저 네이버·카카오로 가입한다.
2. 로그인 토큰으로 `/v1/me`를 호출해 자신의 Mori 사용자 UUID를 확인한다.
3. 신뢰하는 서버 터미널에서 그 UUID에 최고 관리자 역할을 부여한다.

```sh
# backend 디렉터리, 운영 DB 환경 설정 후
uv run mori grant-super-admin --user-id <USER_UUID> --reason "최초 운영 관리자 지정"

# Compose
# docker-compose exec api mori grant-super-admin --user-id <USER_UUID> --reason "최초 운영 관리자 지정"
```

회원 생성·토큰 발급 없이 이미 소셜 가입한 계정의 역할만 변경한다. 첫 가입자를 자동으로 최고 관리자로 만들지 않는다. 이메일이나 닉네임 대신 `/v1/me`의 UUID를 정확히 지정한다. 지정 후 재로그인할 필요 없이 기존 토큰으로 관리자 API를 사용할 수 있다.

최고 관리자 역할 회수도 서버 터미널에서 수행한다.

```sh
uv run mori revoke-super-admin --user-id <USER_UUID> --reason "운영 담당 변경"
```

역할 변경 명령에는 서버·DB 운영 권한이 필요하다. 일반 사용자나 관리자 HTTP API에서는 최고 관리자 역할을 부여할 수 없다. 여러 최고 관리자를 둘 수 있으며, 모두 회수한 경우에도 서버 운영 명령으로 다시 지정할 수 있다. 역할 회수는 프로 등급이나 소셜 로그인 자체를 제거하지 않는다.

## 관리자 API

모든 요청은 `Authorization: Bearer <최고 관리자의 Mori 액세스 토큰>`이 필요하다.

| 메서드·경로 | 기능 |
| --- | --- |
| `GET /v1/admin/users` | 소셜 가입자 목록 |
| `POST /v1/admin/users/{user_id}/pro/approve` | 프로 사용 승인 |
| `POST /v1/admin/users/{user_id}/pro/revoke` | 프로 승인 회수, 무료로 전환 |
| `GET /v1/admin/users/{user_id}/access-history` | 대상 사용자의 최근 권한 변경 이력 |

목록은 UUID 오름차순이며 `limit`은 기본 50, 최대 100이다. `tier=free` 또는 `tier=pro`로 필터링한다. 응답의 `next_cursor`가 있으면 다음 요청에 `cursor`로 넣고 같은 필터를 유지한다. 소셜 식별자·이메일·토큰 원문은 반환하지 않는다. 닉네임이 같을 수 있으므로 대상 사용자의 UUID를 확인한다.

```json
{
  "items": [
    {
      "id": "사용자 UUID",
      "display_name": "테스터",
      "tier": "free",
      "role": "user",
      "created_at": "2026-09-17T00:00:00Z"
    }
  ],
  "next_cursor": null
}
```

승인·회수는 사유가 필요하다. 앞뒤 공백을 제거한 1~300자이며, 저장되는 내용에 제어 문자를 허용하지 않는다. 아래의 UUID·토큰은 실제 값으로 설정한다.

```sh
curl --fail-with-body http://localhost:8000/v1/admin/users/$MORI_TARGET_USER_ID/pro/approve \
  -H "Authorization: Bearer $MORI_ADMIN_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"reason":"초기 테스터 프로 사용 승인"}'

curl --fail-with-body http://localhost:8000/v1/admin/users/$MORI_TARGET_USER_ID/pro/revoke \
  -H "Authorization: Bearer $MORI_ADMIN_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"reason":"프로 테스트 참여 종료"}'
```

성공은 `200`이며 목록 항목과 같은 사용자 객체를 반환한다. 이미 프로인 사용자 승인이나 이미 무료인 사용자 회수는 상태를 유지하고 이력을 추가하지 않는다. 여러 최고 관리자의 상반된 결정은 DB에서 순서대로 처리되며 마지막으로 반영된 상태가 유효하다. 조회 후 상태가 바뀔 수 있으므로 프론트는 처리 응답이나 새 조회 값으로 화면을 갱신한다.

이력은 최신순이며 `limit`은 기본 50, 최대 100이다. 이력이 없는 대상은 빈 배열을 반환한다. 항목에는 `id`, `user_id`, `actor_id`, `action`, `reason`, `created_at`이 있다.

- 프로 승인·회수: `approve_pro`, `revoke_pro`. `actor_id`에 최고 관리자 UUID를 저장한다.
- 서버 운영 명령의 역할 변경: `grant_super_admin`, `revoke_super_admin`. `actor_id`는 null이며 명령의 사유를 저장한다. 실제 터미널 작업자의 식별은 서버 접근 기록으로 관리한다.

권한 변경과 이력 저장은 하나의 트랜잭션이다. 이력 저장에 실패하면 등급 변경도 취소한다. 이력 수정·삭제 HTTP API는 제공하지 않는다. `prune-auth`는 이 이력을 삭제하지 않는다.

## 오류와 권한 반영

| HTTP·코드 | 의미 |
| --- | --- |
| `401 UNAUTHORIZED` | 유효한 소셜 로그인 세션이 필요함 |
| `403 SUPER_ADMIN_REQUIRED` | 최고 관리자 역할이 필요함 |
| `403 PRO_REQUIRED` | 프로 전용 기능에서 사용 승인이 필요함 |
| `404 USER_NOT_FOUND` | 승인·회수 대상이 없거나 소셜 가입하지 않은 기존 알파 계정임 |
| `422 VALIDATION_ERROR` | 잘못된 UUID·필터·한도·사유 또는 정의하지 않은 본문 필드 |
| `503 DATABASE_UNAVAILABLE` | 저장소 오류. 상태를 다시 조회한 뒤 필요한 경우 재시도 |

등급과 역할은 토큰에 고정하지 않고 요청마다 PostgreSQL의 현재 값으로 검사한다. 승인·회수·역할 변경이 commit된 뒤 시작하는 요청에 반영되며 재로그인은 필요 없다. 변경 전에 이미 실행을 시작한 작업을 취소하는 기능은 아니다.

백엔드의 `CurrentProUser` 의존성을 프로 전용 라우트에 붙이면 서버에서 프로 권한을 강제할 수 있다. 현재 주차 API는 무료·프로 모두 사용할 수 있다. 이번 구현은 승인과 권한 판정까지이며 Hermes 연결, 공용·개인 Pod 분기, 이미 실행 중인 작업의 권한 회수 처리는 해당 기능을 개발할 때 연결한다.

## 마이그레이션과 검증

`alembic upgrade head`로 `0003_pro_access`를 적용한다. 기존 사용자도 무료·일반 역할로 초기화되며 소셜 세션과 주차 기록은 유지한다. 운영자를 최고 관리자로 자동 지정하지 않는다. `0002_social_login`으로 롤백하면 등급·역할·이력이 사라지므로 이 데이터가 필요한 운영 DB에서는 먼저 보존해야 한다.

테스트는 실제 PostgreSQL에서 소셜 가입의 기본 등급, 접근 차단, 승인·회수, 기존 토큰 권한 반영, 동시 승인, 이력 저장 실패 시 전체 롤백, 관리자 지정·회수, 마이그레이션을 검증한다.
