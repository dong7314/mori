# 모리 — 내 곁의 작은 비서

`poc` 브랜치의 앱 UI 프로토타입입니다. HTML·JavaScript·SCSS로 만들었으며, App Store의 큰 제목과 에디토리얼 카드에 기존 모리 마스코트를 담았습니다. 휴대폰 세로 화면을 기준으로 태블릿과 가로 화면도 지원합니다.

**네이버·카카오 로그인과 주차 저장·조회는 `master`의 실제 API에 연결됩니다.** 대화·일정·여행·문서 화면은 체험용입니다.

## 화면 보기

Node.js 22.9 이상에서 실행합니다. 빌드된 CSS가 포함되어 있어 미리보기만 열 때는 설치가 필요 없습니다.

```sh
npm start
```

[http://localhost:4173](http://localhost:4173)에서 열어주세요. 기본 설정에서는 `127.0.0.1` 대신 `localhost`를 사용합니다. 서버는 로컬 인터페이스에만 바인딩합니다.

```sh
# 주소를 바꾸려면 .env.example을 .env로 복사한 뒤 편집
cp .env.example .env

# 스타일 수정·검증
npm ci
npm run build
npm run check
npm test
```

`PORT`, `MORI_POC_ORIGIN`, `MORI_API_BASE_URL`로 미리보기와 API 주소를 설정합니다. 기본 API 주소는 `http://localhost:8000`입니다. 환경 설정을 바꾸면 미리보기 서버를 재시작하세요.

## 백엔드 연결

`master` 작업 폴더에서 API와 DB를 실행합니다. 아래 명령은 POC 로그인 복귀 주소를 허용합니다.

```sh
MORI_AUTH_RETURN_URLS='["http://localhost:4173/auth/callback","http://localhost:5173/auth/callback"]' \
  docker compose -p mori-poc-local up -d --build
```

Docker Compose 플러그인 대신 독립 실행 파일을 쓰는 환경에서는 `docker-compose`로 실행합니다. 이미 API가 실행 중이라면 해당 환경의 복귀 주소 설정을 갱신하세요.

소셜 로그인에는 **백엔드의** `MORI_NAVER_CLIENT_ID`, `MORI_NAVER_CLIENT_SECRET`, `MORI_KAKAO_CLIENT_ID`, `MORI_KAKAO_CLIENT_SECRET` 설정이 필요합니다. 키를 POC 소스나 프론트엔드 환경 변수에 넣지 않습니다.

| 등록 위치 | 기본 로컬 주소 |
| --- | --- |
| 네이버 개발자 앱 콜백 | `http://localhost:8000/v1/auth/naver/callback` |
| 카카오 개발자 앱 Redirect URI | `http://localhost:8000/v1/auth/kakao/callback` |
| 백엔드 `MORI_AUTH_RETURN_URLS` | `http://localhost:4173/auth/callback` |
| 백엔드 `MORI_AUTH_PUBLIC_BASE_URL` | `http://localhost:8000` |

로그인 시트의 **개발 연결 정보**에서 적용된 API 주소와 복귀 주소를 확인할 수 있습니다. 공급자 키가 없는 경우 해당 로그인 버튼은 비활성화됩니다. 네이버·카카오 외의 가입, 임의 사용자 ID 로그인, 테스트 계정 우회 기능은 제공하지 않습니다.

## 확인할 흐름

1. 오른쪽 위 모리 얼굴 → 네이버 또는 카카오 로그인 → 무료/프로 계정 확인.
2. **주차 기억** → 지하 2층 선택 → 구역 `C`, 자리 `C36` → 저장 완료 → 오늘에서 확인.
3. 새로고침하거나 재로그인해도 서버에 저장한 마지막 위치를 조회합니다. 다른 계정에는 그 계정의 위치만 표시됩니다.
4. **캘린더 → 일정 직접 추가**에서 대화 없이 약속을 남깁니다. 일정은 이 기기의 체험 데이터입니다.
5. **하단 마이크 → 예시 선택 또는 음성 입력 → 내용 확인 → 대화로 보내기**. 주차 문장은 확인 폼을 거쳐 실제 저장할 수 있습니다.
6. 대화는 생활·여행·문서로 모으고, 대화 안의 더보기에서 분류를 바꿉니다.

## 실제 연결과 미리보기의 범위

| 기능 | 현재 동작 |
| --- | --- |
| 소셜 로그인·세션 갱신·로그아웃 | 실제 Mori API, 네이버·카카오 앱 설정 필요 |
| 무료/프로·최고 관리자 표시 | `/v1/me`의 서버 값을 표시. 결제 없음, 프로 승인 화면은 이번 POC 범위 밖 |
| 주차 기록 저장·조회 | 실제 Mori API·PostgreSQL. 중복 저장 방지 키 사용 |
| 시간대에 맞는 첫 카드 | 기기 시각 기준. 평일 06–10시에 저장된 주차 위치 우선 |
| 대화 목록·그룹·일정·작은 기억 | 계정별로 나눈 기기 내 체험 데이터 |
| 마이크 | 지원 브라우저의 음성 인식. 사용자가 시작한 후에만 권한 요청; 불가하면 직접 입력 |
| 여행 검색·PDF·Excel·파일 분석 | 대화 흐름 미리보기. 파일은 이름만 표시, 내용 업로드 없음 |
| Hermes·모델 호출·자동 학습·예약 실행 | 미연결 |
| 앱 컨테이너·OS 위젯·푸시·승인 알림 | 미연결 |

실제 주차 기록을 로컬 예시 값으로 대신하지 않습니다. API 오류는 재시도 안내로 표시합니다. 음성 인식은 브라우저 서비스가 처리할 수 있으며 모리 서버의 STT 연결은 아닙니다.

## 파일 구조

- `src/app.js`: 화면·탭·시트·폼·음성·대화 흐름
- `src/api.mjs`: 동일 출처 API 호출과 오류 처리
- `src/ui-model.mjs`: 시간대·주차 입력·중복 방지·체험 데이터
- `scripts/server.mjs`: 로그인 PKCE와 서버 세션, 제한된 API 중계
- `styles/main.scss` → `styles/main.css`: 앱 레이아웃·색상·타이포·애니메이션
- `assets/mori.svg`: 기존 마스코트를 유지한 독립 SVG
- `docs/app-poc.md`: 디자인 기준·연동 구조·검증 기록

이전 POC의 순수 모델 모듈과 테스트는 회귀 참고용으로 남아 있으며, 새 화면은 `ui-model.mjs`를 사용합니다. 기존 `mori.poc.v1` 데이터는 수정하지 않습니다. 새 체험 데이터는 `mori.app.preview.v3.*`에 보관합니다.

미리보기의 API 토큰은 서버 메모리에만 저장하고 브라우저에는 HttpOnly 세션 쿠키를 사용합니다. 서버를 재시작하면 다시 로그인해야 합니다. 실제 서비스 배포 시에는 다중 인스턴스용 세션 저장소와 앱 인증 연결을 별도로 구성해야 합니다.
