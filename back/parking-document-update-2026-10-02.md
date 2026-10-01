# 주차 표시·문서 용량 백엔드 변경 — 2026-10-02

코드 기준: `master` `53b0fa6`, API **0.7.0**, migration **0007_parking_display**.
[전체 계획](../plan.md) · [백엔드 계획](plan.md) · [기존 화면 API](screen-api-implementation-2026-09-30.md).

UI/UX 개편 중 서버 데이터가 달라지는 주차 용도·표시 방식과 문서 10MB 제한을 반영했다.
기존 메모·일정·계정·기능 정의/텍스트 결과 계약을 계속 사용하며 DB는 **PostgreSQL**이다.
친구에게 전달하는 Word UI/UX 기획서는 변경하지 않았다.

## 주차

- 저장 요청·응답에 `purpose=commute|external`, `display_mode=always|scheduled`, `display_schedule`을 추가했다.
- 위치만 저장하면 external/always/null이다. 새 위치를 저장할 때까지 상시 카드로 표시한다.
- 출근용도 상시 표시할 수 있다. 용도만 보고 출근 시각을 임의로 설정하지 않는다.
- scheduled에는 시각 HH:MM이 필수다. 시간대 기본 Asia/Seoul, 요일 기본 평일(월=0…일=6), 표시 기간 기본 90분(1~1440분)이다. 요일 중복·잘못된 시간대·상시와 시간 설정 동시 입력은 거부한다.
- 카드의 show_until은 상시일 때 null이다. 상시 key는 날짜가 바뀌어도 유지하고, 지정 시간은 회차별 key를 사용한다. 자정을 넘는 표시와 구간 중 새 위치 저장을 처리한다.
- 사용자별 최신 위치 하나를 표시하며 주차 일시중지 API는 추가하지 않았다.
- 기존 기록은 commute/scheduled/null로 이관하여 이전 출근 문맥을 유지한다. 기존 위치 저장 요청의 해시와 재전송 응답을 보존한다. 같은 키 재전송으로 과거 설정을 덮어쓰지 않는다.
- 채팅도 같은 저장 서비스를 사용하며 실제 저장한 표시 설정을 SSE 결과로 반환한다. 카드 표시 저장은 푸시·Hermes cron 등록이 아니다.

## 문서

- TXT/MD/CSV text 원문을 UTF-8 **10,000,000바이트(10MB)**까지 저장한다. 공백·줄바꿈을 보존한다.
- `GET /v1/documents`는 원문 text를 제외한 메타데이터와 size_bytes를 반환한다. 프론트에서 원문이 필요하면 상세 또는 download API를 사용한다.
- 생성·상세·삭제·복원 응답은 원문을 포함하는 기존 계약을 유지한다.
- 보관함과 대시보드 최근 기록은 PostgreSQL에서 160자까지만 읽어 큰 원문 전체를 목록으로 전송하지 않는다.
- DOCX/XLSX/HWP/PDF 업로드·변환·AI 요약은 후속이다. 이번 10MB 지원은 기존 텍스트 형식에 적용한다.

## 검증과 다음 적용

PostgreSQL 18의 별도 테스트 DB에서 **204개 전체 테스트** 통과. 기존 기록/요청 키 보존과 롤백,
readiness, 사용자 격리, 멱등 생성, 표시 요일/자정/종료 경계, 채팅 설정 저장,
10MB 경계·원문 재전송/다운로드·초과 거부를 검증했다. Ruff와 OpenAPI 일치 검사도 통과했다.
Windows에서도 OpenAPI의 한글이 보존되도록 생성기를 UTF-8로 고정했다.

적용 순서:

1. 새 Mori API 이미지 준비 후 `uv run alembic upgrade head`로 0007까지 적용한다. 미적용 DB는 readiness 503이다.
2. 프론트에 새 주차 필드·nullable show_until·문서 목록/상세 분리를 연결한다.
3. 실제 Hermes/GPU 모델에서 새 주차 입력과 저장 결과를 확인한다.
4. 프록시 body 한도는 JSON 인코딩·메타데이터까지 통과할 수 있도록 원문 10MB보다 여유 있게 설정한다.

0007을 내려 새 주차 컬럼을 삭제하면 용도·표시 설정은 재업그레이드로 복원되지 않는다.
위치·시각·요청 키·해시는 보존된다. 이번 작업은 코드·문서·테스트이며 이미지 빌드,
Harbor push, 운영 DB migration, k3s 배포와 실제 GPU 호출은 수행하지 않았다.

정확한 계약: [주차 API](https://github.com/dong7314/mori/blob/53b0fa6/backend/docs/parking-api.md),
[화면 API](https://github.com/dong7314/mori/blob/53b0fa6/backend/docs/screen-api.md),
[OpenAPI](https://github.com/dong7314/mori/blob/53b0fa6/backend/docs/openapi.json).
