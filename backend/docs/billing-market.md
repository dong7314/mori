# 결제와 주가 제공자 연결

웹 구독은 토스페이먼츠 자동결제, 주가 조회는 한국투자증권 Open API를 지원한다. 기본 설정에서는 두 연결이 모두 비활성이다. 실제 계정 가입·키 발급·금액 결정·운영 결제·외부 API 호출은 이 코드 변경에 포함하지 않는다.

## 웹 Pro 구독

서버 Secret에 다음 값을 설정한다.

```dotenv
MORI_BILLING_ENABLED=true
MORI_BILLING_TOSS_SECRET_KEY=실제_개별연동_시크릿키
MORI_BILLING_TOSS_CLIENT_KEY=대응하는_클라이언트키
MORI_BILLING_ENCRYPTION_KEY=Fernet_키
MORI_BILLING_PRO_AMOUNT=운영자가_결정한_KRW_월금액
MORI_BILLING_SUCCESS_URL=https://프론트주소/billing/success
MORI_BILLING_FAIL_URL=https://프론트주소/billing/fail
MORI_BILLING_LEASE_SECONDS=300
```

금액 예시를 기본 요금으로 사용하지 않는다. Fernet 키는 서버에서 생성해 보관하고 기존 결제 토큰을 읽는 동안 유지해야 한다. DB의 일회용 인증 키와 빌링키는 암호화해서 저장하며 API 응답에 노출하지 않는다. 카드 번호·유효기간·CVC를 Mori API로 받지 않는다.

1. 로그인 후 `POST /v1/billing/checkouts`에 UUID `Idempotency-Key`를 보낸다. 서버가 무작위 고객 키, 고정된 금액, 완료·실패 URL, 공개 클라이언트 키를 반환한다. 이 단계는 과금하지 않는다.
2. 프론트는 반환된 값으로 Toss 결제수단 등록 SDK를 실행한다. 등록 동의 화면에서 월 금액과 자동 갱신을 안내한다. PoC 화면 자체는 이번에 연결하지 않았다.
3. 인증 완료 후 같은 Mori 사용자 세션으로 `POST /v1/billing/checkouts/{id}/complete`에 `{customer_key,auth_key}`를 보낸다. 사용자·고객 키·15분 유효기간을 검사하고 **202와 영속 결제 작업**을 반환한다. 202를 결제 완료로 표시하면 안 된다.
4. 서버 worker는 기존 주문을 먼저 조회한다. 결제가 없으면 빌링키 발급과 승인을 요청하고, 주문 ID·금액·통화·결제 종류·승인 상태를 검증한 뒤 Pro를 부여한다.
5. `GET /v1/billing/orders/{id}`와 `GET /v1/me/subscription`으로 상태를 확인한다. 주문 목록은 `/v1/billing/orders`에서 페이지 단위로 조회한다.

고객 키는 서버가 발급한 값을 그대로 사용한다. 한글 등 비ASCII 문자가 포함되거나 값이 다르면 `422 CHECKOUT_CUSTOMER_MISMATCH`로 거부한다. 이 요청으로 주문·구독·등급을 바꾸거나 체크아웃을 소비하지 않으며, 정상 키로 다시 완료 요청을 보낼 수 있다.

결제 요청마다 같은 주문 ID와 제공자 멱등 키를 사용한다. 네트워크가 끊기면 새 주문으로 다시 과금하지 않고 기존 주문 조회부터 재개한다. 최대 시도 뒤 결과가 불확실하면 `review`로 두며 새 결제 시작도 차단한다. `/orders/{id}/reconcile`은 인증된 사용자가 제공자 조회를 다시 요청하는 경로다. `review`에서는 추가 과금 없이 조회만 수행한다. 운영자는 제공자 결제 내역과 주문 ID를 확인해야 한다.

구독의 월 금액은 가입 당시 값으로 유지된다. 서버 요금 설정을 바꿔도 기존 구독을 몰래 새 금액으로 갱신하지 않는다. 정기 결제는 만료 시각 이후 worker가 처리하며, 중단 기간 동안 빠진 여러 달을 한꺼번에 청구하지 않는다. 승인된 시각부터 다음 달 같은 날짜까지 이용권을 부여한다. 날짜가 없는 달에는 말일을 사용한다.

`POST /v1/billing/subscription/cancel {revision}`은 다음 결제를 중지하며 이미 결제된 기간은 유지한다. 기간 안에서는 `/resume`으로 갱신 중지를 철회할 수 있다. 이는 즉시 환불 API가 아니다. 환불은 상점의 환불 정책에 따라 제공자에서 처리하고, 전체 취소가 확인되면 해당 결제 이용권을 회수한다. 관리자 승인 이용권은 유료 구독과 별도로 보존한다. 권한 검사는 worker가 멈춰 있어도 만료 시각을 적용한다.

토스에는 `PAYMENT_STATUS_CHANGED`를 `/v1/billing/webhooks/toss`로 등록한다. **웹훅 본문 자체는 신뢰하지 않는다.** 이미 알려진 주문의 재조회 요청만 저장하고, 서버 시크릿 키로 결제 API를 조회한 결과만 반영한다. 모르는 주문은 동일한 202로 무시하고, 같은 주문의 재조회는 합치며 짧은 간격의 요청은 지연 처리한다. 웹훅이 전달한 사용자·금액·상태로 이용권을 바꾸지 않는다.

이 공급자는 웹용 자동결제다. iOS StoreKit 및 Google Play 구매 검증은 이 API의 토스 결제 완료로 대체하지 않는다. 신규 앱 결제 공급자는 동일한 이용권 모델에 별도 검증된 결제 경로로 연결해야 한다.

공식 근거: [토스 코어 API](https://docs.tosspayments.com/reference), [자동결제](https://docs.tosspayments.com/resources/glossary/billing), [웹훅 이벤트](https://docs.tosspayments.com/reference/using-api/webhook-events).

## KIS 시세

```dotenv
MORI_KIS_ENABLED=true
MORI_KIS_APP_KEY=서버_전용_AppKey
MORI_KIS_APP_SECRET=서버_전용_AppSecret
MORI_KIS_SYMBOLS={"AAPL":"NAS","MSFT":"NAS","IBM":"NYS"}
```

지원 예시는 `005930.KS`(삼성전자), `KOSPI` 또는 `^KS11`, `KOSDAQ` 또는 `^KQ11`, `AAPL`이다. 한국 주식은 6자리 코드와 선택적인 `.KS`/`.KQ` 접미사를 사용한다. 미국 종목은 서버 설정의 거래소 목록에 있어야 한다. KIS 호출 origin은 공식 실전 서버로 고정되며 주문·매매 API는 사용하지 않는다.

기존 `/v1/market/settings`, `/quote`, `/candles?range=day|week|month`, `/snapshot` 계약을 재사용한다. KIS가 활성화되면 기존 gateway보다 우선한다. 비활성일 때는 기존 `MORI_MARKET_DATA_BASE_URL` gateway가 계속 동작한다.

국내 주식의 `range=day`는 **당일 완료된 1분봉**을 반환한다. KIS `inquire-time-itemchartprice`(`FHKST03010200`)를 시간 커서로 거슬러 조회하며 `cntg_vol`을 분당 거래량으로 사용한다. 현재 진행 중인 분은 제외한다. 일봉을 여러 봉으로 늘리거나 없는 분의 가격을 임의로 채우지 않는다. WebSocket 실시간 체결 스트림은 아니다.

응답은 `interval=1m`, `price_kind=intraday`, `as_of_precision=minute`, `timezone=Asia/Seoul`, `session_date`, `observed_at`을 제공한다. `as_of`는 마지막 봉의 시각이다. 장전·주말·당일 데이터가 없는 경우 `candles=[]`, `as_of=null`과 `empty_reason`을 반환한다. 평일 휴장과 종목별 데이터 부재를 확정적으로 구분할 수 없으면 `no_current_session_data`다. 지난 거래일 데이터로 대체하지 않는다. 프론트는 이 경우 차트 대신 데이터가 없는 상태를 표시한다.

현재 수집 시간 범위는 **한국 시간 09:00–15:30**이다. 수능일 등 특수 개장일의 변경된 장시간, 시간 외 거래, NXT는 이 범위에 포함하지 않는다. 해당 날짜까지 온전한 일중 차트를 제공하려면 거래일별 장시간 정책을 추가해야 한다. `truncated`는 이 시간 범위 안에서 조회 페이지 한도에 도달했는지를 뜻하며 특수 개장일 지원 여부가 아니다.

각 페이지는 최대 30봉, 전체 최대 14페이지, 요청 전체는 20초로 제한한다. 중복 봉은 값이 같을 때만 합치고, 다른 날짜·미래 봉은 제외한다. 커서가 진행되지 않거나 가격·시각·OHLC가 잘못된 경우 오류를 반환한다. 페이지 한도에 도달하면 `truncated=true`, 중간 HTTP 실패에서는 부분 결과를 성공으로 반환하지 않는다.

국내 `week/month`, KOSPI/KOSDAQ·미국 주식의 모든 기간, `/quote`와 예약 `/snapshot`은 기존 **완료된 거래일 일봉·종가** 계약이다. `interval=1d`(캔들), `price_kind=close`, `as_of_precision=session_date`를 확인해 분봉과 구분한다. 거래소 현지 날짜의 당일 일봉은 제외하고 `as_of`는 원본 거래일의 자정으로 표현한다. 자정 체결 시각이 아니다. 지수의 통화 단위는 `POINT`다. 일봉의 `day`는 최근 거래일 1개, `week`는 최근 거래일 기준 7일, `month`는 31일이다. **분봉 차트와 별도로 받은 종가를 장중 현재가로 표시하지 않는다.**

`PUT /market/settings`는 종목과 선택적 `schedule`을 함께 저장한다. `schedule` 생략은 기존 예약 유지, 명시적 `null`은 해제다. 기존 stock 기능의 예약 수정은 `feature_revision`을 함께 보내며, 종목 버전 `revision`과 별도로 충돌을 검증한다. 설정 응답은 `feature_id`, `feature_revision`, `schedule`을 제공한다.

액세스 토큰은 만료 전에 갱신하고 프로세스 안에서 재사용한다. 각 worker 프로세스가 별도 토큰 캐시를 가지므로 운영 시 제공자 발급 한도에 맞춰 worker 수와 실행 간격을 설정한다. 공급자 오류 메시지나 자격 증명을 사용자 응답으로 전달하지 않는다. 날짜·중복·가격·OHLC 유효성은 기존 응답 검증으로 확인한다.

공식 근거: [KIS 공식 저장소](https://github.com/koreainvestment/open-trading-api), [국내 기간별 시세](https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/domestic_stock/inquire_daily_itemchartprice/inquire_daily_itemchartprice.py), [해외 기간별 시세](https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/overseas_stock/dailyprice/dailyprice.py).

분봉의 공식 근거: [당일 분봉 요청·거래 ID·30건 제한·현재분 주의사항](https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/domestic_stock/inquire_time_itemchartprice/inquire_time_itemchartprice.py), [응답 필드·분당 거래량](https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/domestic_stock/inquire_time_itemchartprice/chk_inquire_time_itemchartprice.py).

## 검증 범위

HTTP transport를 대체해 실제 돈과 시장 계정을 사용하지 않고 인증·소유권·암호화·중복 요청·응답 유실 복구·위조 웹훅·이용권 만료·관리자 승인 보존·제공자 필드 매핑을 검증한다. 운영 가동 전에는 제공자 테스트 상점/키, callback, worker, 실제 검색과 시세 응답, 결제 취소 통지까지 별도 확인한다.

## 조회 복구와 종료된 구독

환불·취소 웹훅을 받은 뒤 제공자 조회에 실패하면 확인 요청을 소비한 것으로 처리하지 않는다. 60초 뒤 다시 조회하고 조회 중 worker가 종료되면 lease 만료 후 다른 worker가 이어받는다. 이미 완료된 주문을 확인할 때는 청구 API를 다시 호출하지 않는다. 제공자가 확인될 때까지 기존 결제 기록을 근거 없이 환불로 확정하지 않는다.

최초 승인 응답이 유실된 뒤 주문 조회가 401·403 등으로 거부돼도 이를 결제 거절로 확정하지 않는다. 기존 주문은 확인 대기·재검토 상태를 유지해 새 주문으로 중복 결제하는 것을 막는다. 조회 연결이 복구되면 원래 주문의 승인 내역을 확인한다. 실제 청구 요청에 대한 확정 거절은 기존처럼 실패로 기록하고 새 결제수단 등록을 허용한다.

전액 환불 등으로 이미 종료된 구독은 과거 period_end가 미래로 남아 있어도 `/subscription/resume`에서 `409 SUBSCRIPTION_ENDED`를 반환한다. 기간 말 갱신 중단을 취소하는 재개와 이미 끝난 구독을 다시 결제하는 절차를 구분한다.


## 동시 조회와 과거 주문의 경계

예약·채팅 시세 조회가 겹쳐도 최신 snapshot은 제공자의 as_of가 더 오래된 응답으로 덮어쓰지 않는다. as_of가 같고 양쪽에 observed_at이 있으면 더 오래된 관측도 제외한다. 관측 정보가 없거나 두 시각이 완전히 같으면 기존처럼 마지막 완료 결과를 사용한다. 비교와 저장은 사용자·시세 행의 기존 잠금 안에서 수행한다. 늦게 완료한 작업의 답변·회차 FeatureResult에는 그 작업이 실제 조회한 가격과 시각을 그대로 보존한다.

첫 성공 조회가 이미 전액 취소된 결제를 보고해도 현재 미확정 주문에 연결된 구독을 canceled로 종료한다. pending·review·past_due에 고착하지 않는다. 과거 완료·취소·실패 주문을 다시 확인할 때는 현재 결제 기간 또는 현재 미확정 주문인지 구분한다. 이전 주문의 환불이 새 결제 대기 상태나 새 구독의 cancel_at_period_end를 바꾸지 않으며, 현재 결제의 실제 환불에 대한 이용권 회수는 유지한다.


일반 시세 제공자의 quote/candles 응답은 as_of와 observed_at이 서버 수신 시각보다 5분을 초과해 미래이면 `502 INVALID_MARKET_RESPONSE`로 거부한다. 5분까지의 시계 오차는 허용한다. 기존 snapshot도 원래 서버 collected_at보다 5분 초과 미래인 값을 기준으로 계속 고착시키지 않는다. 오염된 as_of는 정상 시세로 교체할 수 있고, observed_at만 오염됐으면 유효한 as_of 순서 보호를 유지하면서 동률의 관측 시각 비교만 무효화한다. KIS의 날짜 필터와 서버에서 만든 관측 시각 계약은 유지한다.
