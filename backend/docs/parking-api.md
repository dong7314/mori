# 주차 저장·조회 계약

이 API는 구조화된 위치를 받는다. `지하 2층 C구역 C36에 주차했어` 같은 자연어를 그대로 보내는 대화 API는 다음 단계에서 제공한다.

## 공통

- 인증: `Authorization: Bearer <발급된 토큰>`.
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

세 필드 중 최소 하나가 필요하다. 빈 문자열과 위치 내부의 제어 문자는 거부한다. `B2`, `지하 2층` 등 값은 공백 제거 외에는 그대로 저장한다.

새 기록은 `201 Created`, 같은 사용자·키·정규화된 내용의 재전송은 `200 OK`다. 응답 구조는 동일하다.

```json
{
  "id": "082fe0ad-4a37-41f1-a955-62f5c74b22e6",
  "floor": "B2",
  "zone": "C",
  "spot": "C36",
  "recorded_at": "2026-09-17T00:30:00Z"
}
```

ID와 시각은 예시다. 프론트는 서버에서 성공을 받은 뒤 이 데이터로 완료 상태를 표시한다. 요청 키는 저장 동작을 시작할 때 한 번 만들고, 통신 오류·시간 초과 후 재전송할 때 재사용한다. 새 주차 동작에는 새 키를 사용한다.

```sh
# MORI_ACCESS_TOKEN에는 관리 CLI에서 발급한 값을 설정한다.
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
