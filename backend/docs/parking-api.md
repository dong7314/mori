# 주차 저장·조회 계약

API 0.7.0 기준으로 위치와 주차 용도·표시 방식을 받는다. 자연어 입력은 [대화 API](chat.md)에서 해석하고 같은 저장 서비스를 사용한다. 저장소는 PostgreSQL이다.

## 공통

- 인증: [네이버·카카오 로그인](social-login.md)에서 받은 Mori 액세스 토큰을 `Authorization: Bearer <access_token>`으로 전송한다. 소셜 제공자의 토큰을 직접 받지 않는다.
- 저장 요청: `Content-Type: application/json`, `Idempotency-Key: <작업별 UUID>`.
- 사용자는 인증 문맥으로 결정한다. body의 `user_id`, `recorded_at` 등 미정의 필드는 거부한다.
- 표시 시각은 `recorded_at`의 UTC 시각을 사용자 시간대로 변환한다.
- Swagger UI: `/docs`, 기계용 계약: `/openapi.json`.

## 저장

`POST /v1/parking-records`

```json
{
  "floor": "B2",
  "zone": "C",
  "spot": "C36"
}
```

| 필드 | 형식 | 규칙 |
| --- | --- | --- |
| `floor` | 문자열 또는 null | 생략 가능, 제공 시 공백 제거 후 1~32자 |
| `zone` | 문자열 또는 null | 생략 가능, 제공 시 공백 제거 후 1~64자 |
| `spot` | 문자열 또는 null | 생략 가능, 제공 시 공백 제거 후 1~64자 |
| `purpose` | `commute` / `external` | 출근용 / 외부 주차. 기본 `external` |
| `display_mode` | `always` / `scheduled` | 상시 / 지정 시간 표시. 기본 `always` |
| `display_schedule` | 객체 또는 null | `scheduled`에 필수, `always`에는 null 또는 생략 |

세 필드 중 최소 하나가 필요하다. 빈 문자열과 위치 내부의 제어 문자는 거부한다. `B2`, `지하 2층` 등 값은 공백 제거 외에는 그대로 저장한다.

위치만 보내면 새 위치가 저장될 때까지 상시 표시한다. 출근용도 상시 표시할 수 있으며 용도만으로 표시 시각을 임의로 정하지 않는다. 지정 시간 표시 예시:

```json
{
  "spot": "B16",
  "purpose": "commute",
  "display_mode": "scheduled",
  "display_schedule": {
    "time": "08:30",
    "timezone": "Asia/Seoul",
    "days": [0, 1, 2, 3, 4],
    "duration_minutes": 90
  }
}
```

`time`은 필수 HH:MM, timezone은 IANA 시간대(기본 Asia/Seoul), days는 중복 없는 월요일=0…일요일=6(기본 평일), duration_minutes는 1~1440(기본 90)이다. 요일은 표시 시작 날짜 기준이고 자정을 넘는 구간도 처리한다. 지정 시각부터 기간 동안 표시하며 종료 시각은 제외한다. 이 설정은 앱 카드 표시이며 푸시 알림·Hermes 예약 등록이 아니다.

새 기록은 `201 Created`, 같은 사용자·키·정규화된 내용의 재전송은 `200 OK`다. 응답 구조는 동일하다.

```json
{
  "id": "082fe0ad-4a37-41f1-a955-62f5c74b22e6",
  "floor": "B2",
  "zone": "C",
  "spot": "C36",
  "recorded_at": "2026-09-17T00:30:00Z",
  "purpose": "external",
  "display_mode": "always",
  "display_schedule": null
}
```

ID와 시각은 예시다. 프론트는 서버에서 성공을 받은 뒤 이 데이터로 완료 상태를 표시한다. 요청 키는 저장 동작을 시작할 때 한 번 만들고, 통신 오류·시간 초과 후 재전송할 때 재사용한다. 새 주차 동작에는 새 키를 사용한다.

용도·표시 방식·시간 설정도 멱등 입력에 포함된다. 요일 순서만 바꾼 재전송은 동일 입력이다. 기존 위치만 보낸 요청의 해시는 보존하며, 동일 키 재전송으로 기존 기록의 표시 방식을 변경하지 않는다.

`0007_parking_display` 마이그레이션은 기존 기록을 `commute`/`scheduled`/null로 유지한다. 이 null은 이전 기록에만 허용되는 호환 상태로, 기존 내부 비서 문맥의 출근 시각·요일·표시 간격을 사용한다. 신규 scheduled 요청에는 명시적인 schedule이 필요하다.

```sh
# MORI_ACCESS_TOKEN에는 소셜 로그인 코드 교환으로 받은 Mori access_token을 설정한다.
MORI_REQUEST_ID=$(uuidgen)
curl --fail-with-body http://127.0.0.1:8000/v1/parking-records \
  -H "Authorization: Bearer $MORI_ACCESS_TOKEN" \
  -H "Idempotency-Key: $MORI_REQUEST_ID" \
  -H 'Content-Type: application/json' \
  --data '{"floor":"B2","zone":"C","spot":"C36"}'
```

## 최신 조회

`GET /v1/parking-records/latest`

성공하면 저장 API와 같은 형태의 기록을 `200 OK`로 반환한다. 기록이 없으면 `404 PARKING_NOT_FOUND`이며 대시보드는 주차 기록 없음 상태를 표시한다. Hermes나 GPU 호출은 발생하지 않는다.

대시보드는 사용자별 최신 위치 하나를 표시한다. 상시 카드는 안정적인 key를 사용하고 `show_until=null`이다. 지정 시간 카드에는 occurrence별 key와 시작·종료 시각이 있다. 저장 이전 시각에는 표시하지 않으며, 표시 구간 도중 저장한 위치는 바로 표시한다. 별도의 주차 일시중지 API는 없다.

```sh
curl --fail-with-body http://127.0.0.1:8000/v1/parking-records/latest \
  -H "Authorization: Bearer $MORI_ACCESS_TOKEN"
```

## 오류

```json
{
  "error": {
    "code": "PARKING_NOT_FOUND",
    "message": "아직 저장한 주차 위치가 없습니다."
  }
}
```

| HTTP | code | 처리 |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | 인증 누락·잘못된 토큰·만료·폐기. 유효한 토큰 필요 |
| 404 | `PARKING_NOT_FOUND` | 최초 사용자의 정상적인 빈 상태 |
| 409 | `IDEMPOTENCY_CONFLICT` | 같은 키에 다른 내용을 보냄. 의도한 별도 저장에만 새 키 사용 |
| 422 | `VALIDATION_ERROR` | 위치·JSON·필수 헤더 확인. 위치 내용과 토큰은 오류 응답에 되돌려주지 않음 |
| 503 | `DATABASE_UNAVAILABLE` / `RETRY_REQUEST` | 지연 후 같은 요청 키로 재시도 |

API 경로 자체가 없거나 HTTP 메서드가 잘못된 경우는 프레임워크의 기본 404·405 응답을 사용한다.
