# 런타임·백그라운드 실행의 운영 적용 로드맵

작성일: 2026-11-03 · 코드 기준: `master` **6285abac905b242442cceda103c63e18d8900ab3** · API **0.9.0** · DB **0017_news_refresh_deadline**

[아키텍처 개요](plan.md) · [백엔드 현황](../back/implementation-status-2026-11-03.md) · [전체 계획](../plan.md)

이 문서는 앞으로 실행할 운영 작업과 인수 기준이다. 이번 업데이트에서는 서버 접속, Secret 생성, 결제, 이미지 빌드·push, Kubernetes apply를 수행하지 않았다. `master`에 코드와 YAML이 존재하는 상태를 실제 운영 적용으로 표시하지 않는다.

## 1. 구현된 구성과 아직 연결하지 않은 구성

| 구성 | 반영된 내용 | 남은 작업 |
| --- | --- | --- |
| API | 인증·개인 기록·채팅 접수/관찰·파일·기능·결제·운영 상태 | 공개 origin·실제 소셜 콜백·TLS·클라이언트 연결 |
| `mori worker` | 채팅·예약/prewarm·문서·결제·Web Push 독립 처리와 heartbeat | 운영 Secret·플래그·이미지·자원·제공자 확인 |
| runtime provisioner | 유효 Pro → 사용자 Secret/PVC/ConfigMap/Knative Service, lease/generation·회수/재승인 | RBAC·Knative 기능 플래그·CNI·스토리지·실제 lifecycle |
| Free gateway | 공용 부모와 사용자별 자식/HOME, 검색 도구 제한·용량/유휴 검사 | 새 이미지 실제 기동·UID/신호·GPU/검색·두 계정 검증 |
| SearXNG | 공용 검색 연결과 이미지 도구 | 최신 설정·외부 엔진 CAPTCHA/제한·복구 상태 확인 |
| 파일 처리 | DB에 원본·결과 바이트 보관, 별도 subprocess의 제한된 파서/worker | Linux 자원 제한·컨테이너 글꼴·대표 원본 문서 인수 |
| 앱/웹 | React 웹 + RN WebView·독립 release 설계 | 실제 구현·세션/브리지·권한·push/위젯·기기 인수 |

새 공유 gateway와 문서 읽기 변경을 운영하려면 **새 Hermes 이미지를 빌드해야 한다.** 과거 Harbor의 `0.1.0` 등록 성공이나 9월 단일 사용자 cold start 결과는 최신 이미지의 빌드·배포 증거가 아니다. 기본 이미지 모드 검사는 공유 모드 기동 검사를 대신하지 않는다.

## 2. 책임과 권한 경계

- API는 사용자 인증과 소유권을 확인하고 durable 작업을 접수한다. API와 일반 worker는 Kubernetes 토큰을 마운트하지 않는다.
- provisioner만 `mori-agents`의 지정 자원을 관리한다. 기존 YAML은 Service get/create/delete, Secret/ConfigMap get/create/delete, PVC get/create, Pod list의 제한된 Role을 사용한다. 배포 환경에서 실제 권한을 확인한다.
- Pro 권한은 관리자 승인 또는 유효한 결제 기간으로 계산한다. 저장된 tier만으로 만료된 구독의 개인 환경 접근을 계속 허용하지 않는다.
- Free는 공용 Deployment 안에서 UUID별 자식·HOME을 분리한다. 같은 UID의 논리적 분리이므로 임의 코드·터미널·파일 실행을 허용하는 보안 sandbox로 확장하지 않는다.
- Pro는 사용자별 Knative Service/PVC/키를 갖는다. min-scale 0/max-scale 1은 **해당 Revision**의 설정이다. 같은 RWO 볼륨을 사용하는 이전/새 Revision의 중복 작성 방지는 별도 종료 확인 절차가 필요하다.
- 예약 원장과 실행자는 Mori DB·worker다. Hermes cron은 별도 예약 원장으로 쓰지 않는다. prewarm은 실행 준비이며 수집·저장 완료가 아니다.

## 3. A-08: 이미지와 배포 입력 확정

1. 깨끗한 서버 checkout에서 검증된 `master` 커밋을 선택하고 릴리스 기록에 남긴다. `plan`은 문서 브랜치이며 실행 코드의 배포 원본으로 사용하지 않는다.
2. backend와 Hermes 이미지를 노드 아키텍처에 맞게 빌드한다. backend는 현재 `uv.lock`을 사용하고 문서 의존성·한글 폰트가 포함되는지 확인한다. Hermes는 기본 모드와 공유 모드를 각각 기동한다.
3. backend 이미지의 API·일반 worker·provisioner 명령을 각각 실행해 시작 경로를 확인한다. Hermes 공유 모드에서는 stage2/권한 하강 후 UID·사용자 HOME·자식 종료와 신호 전달을 확인한다.
4. Harbor에 버전 태그로 게시하고 결과 digest를 기록한다. 같은 backend digest를 API·migration Job·worker·provisioner에 지정하고, 새 Hermes digest를 공용 gateway와 관리형 개인 런타임 설정에 반영한다.
5. `mori-backend:dev` 등 예시 이미지는 실제 digest로 바꾼다. 기존 일반 runtime 생성기를 새 공유 gateway나 개인 Service 생성기의 대체로 사용하지 않는다.
6. CI의 backend/runtime job 결과를 해당 커밋에서 확인한다. 이번에 보고한 로컬 테스트 통과를 GitHub Actions의 Docker 빌드 성공으로 대신 기록하지 않는다.

완료 증거: 커밋·두 이미지 digest·노드 아키텍처·CI URL/결과·각 모드 기동 로그의 비밀정보를 제거한 요약. 이미지 크기·pull 시간·최대 메모리는 같은 환경에서 측정한다.

## 4. A-09: Secret·DB·API·worker 준비

### 설정의 소유 위치

| 설정 묶음 | 주요 키/값 | 준비 기준 |
| --- | --- | --- |
| 공통 데이터/인증 | `MORI_DATABASE_URL`, 공개 API origin, 반환 URL, CORS, 소셜 앱 키 | 실제 callback allowlist와 DB 접속·TLS 확인 |
| 채팅 | `MORI_CHAT_ENABLED`, `MORI_CHAT_WORKER_ENABLED` | 두 플래그와 실제 worker가 모두 필요 |
| Free 라우팅 | `MORI_SHARED_HERMES_ENABLED`, URL, 서버 전용 API key | gateway의 `MORI_SHARED_GATEWAY_KEY`와 같은 키, 클라이언트에 노출하지 않음 |
| 개인 런타임 | `MORI_RUNTIME_PROVISIONING_ENABLED`, namespace/image/master key/LLM/model/storage/registry 설정 | API·worker·provisioner의 일관된 운영자 설정 |
| 예약 | `MORI_AUTOMATION_ENABLED`, `MORI_AUTOMATION_PREWARM_SECONDS` | 기본 120초, 실제 기동·추론 지연으로 조정 |
| 문서 | `MORI_DOCUMENTS_ENABLED`, 폰트·파일/사용자 한도 | 컨테이너 파서/글꼴과 디스크·DB 사용량 확인 |
| Push | `MORI_PUSH_ENABLED`, VAPID·연락처·HTTPS | 브라우저 구독·service worker·사용자 허용 필요 |
| 뉴스/주가/전사 | SearXNG URL, 선택적 `MORI_NEWS_SUMMARY_ENABLED`, KIS 키, 전사 endpoint/key | 각 제공자 실제 권한/응답 확인, 없으면 해당 기능 비활성 |
| 결제 | `MORI_BILLING_ENABLED`, Toss 키·서버 가격·고정 callback·암호화 키 | 제공자 테스트 환경부터 검증, 앱 IAP는 별도 |

실제 값은 Git이 아닌 서버 Secret/보호된 운영 설정에 둔다. `MORI_RUNTIME_MASTER_KEY`와 `MORI_BILLING_ENCRYPTION_KEY`는 서로 다른 Fernet 키를 사용하고 백업·복구 절차를 마련한다. 임의 재생성은 기존 암호문을 복호화할 수 없게 하므로 키 교체에는 재암호화 계획이 필요하다.

### 적용 순서

1. 현재 DB·Hermes home의 백업과 복원 경로, 적용 중인 이미지·설정을 확인한다. 실제 데이터 이관 전에는 새 DB의 migration 왕복 통과만으로 복구 가능하다고 판단하지 않는다.
2. API/worker 호환성을 확인하고 필요한 유지보수 구간을 정한다. release별 migration Job 이름으로 **0017_news_refresh_deadline**까지 한 번 적용한다. 오래된 가이드의 `0004` Job 이름·단일 사용자 patch를 새 운영 계약으로 복사하지 않는다.
3. migration 성공 후 새 API를 실행한다. `/health/live`와 `/health/ready`는 프로세스·DB 스키마 확인이며 모든 외부 제공자의 준비 보장이 아니다.
4. 필요한 기능 플래그와 함께 별도 `mori worker`를 실행한다. K3s 예시의 명령은 `[mori, worker]`, provisioner는 `[python, -m, mori.runtimes.worker]`다.
5. `mori worker-health`와 인증된 `/v1/capabilities`에서 **configured**와 실제 heartbeat의 running/degraded/unavailable을 구분한다. 채팅·문서·결제 등 활성화한 worker가 빠졌으면 준비 완료로 처리하지 않는다.
6. 공개 TLS origin에서 실제 소셜 로그인·갱신·로그아웃을 확인한다. 기존 인증 우회 토큰을 새로 만들지 않는다.

## 5. A-10: 공용 gateway와 개인 런타임 실제 인수

### 먼저 확인할 클러스터 조건

Knative Serving/Kourier와 scale-to-zero, initContainers·securityContext·nodeSelector·tolerations·PVC·PVC write 기능을 확인한다. Harbor pull Secret과 `mori-agents`의 provider Secret, 사용자 설정에 맞는 StorageClass·노드 배치·볼륨 권한이 필요하다. API/worker 설정과 생성 namespace의 Secret 이름을 혼동하지 않는다.

네트워크 정책은 실제 CNI가 강제해야 한다. 개인 Pod ingress 정책과 gateway ingress 정책의 허용 namespace·label·포트를 배포 환경과 대조한다. 현재 정책은 검색·모델 접근을 위한 egress를 전부 차단하지 않으며, 사설 GPU 방화벽은 별도로 확인한다.

| 검사 | 수행 흐름 | 완료 기준 |
| --- | --- | --- |
| Free 두 사용자 | 각자 로그인→채팅→재접속→부모 재시작 | 서로 다른 자식/HOME·대화, 프로필 보존·키 재생성, 다른 계정 자료 비혼합 |
| Free 용량/유휴 | 비활성 자식 회수, 사용 중 용량 초과 | 진행 중 스트림을 임의 회수하지 않음, 명시적 capacity 오류 |
| Pro 승인/결제 | 유효 Pro→provisioner→runtime 조회 | 사용자 전용 Service/PVC/키, 내부 키·Route 미노출 |
| 0→1 | Pod 0 확인 후 해당 Route로 실제 요청 | 인증 응답·새 Pod Ready·실제 작업 저장, 준비 시간과 추론 시간 별도 기록 |
| 1→0 | 요청 종료 후 유휴 관찰 | Knative가 자동 종료, PVC 유지, 정상 신호/종료 확인 |
| 회수/재승인 | 권한 회수 중 생성 경합→재승인 | 접근 차단, 이전 Pod 종료 후 새 키·동일 사용자 PVC 재사용 |
| 설정 교체 | 이미지/ConfigMap 변경→오류 확인→회수·종료·재배정 | 기존/신규 작성자 중복 없음, 다른 소유자 자원 미변경 |
| 장애 | 이미지 pull/PVC/GPU/CNI 장애·provisioner 재시작 | 상태·오류·재시도가 추적되고 무한 준비/몰래 공용 우회 없음 |

`/v1/me/runtime`의 ready만 확인해 active Pod가 있다고 결론내리지 않는다. 기존 수동 `MORI_CHAT_PRIVATE_RUNTIMES`는 자동 이관되지 않으며, 운영자 배정에서 관리형으로 옮길 때 실행 중단과 데이터 이전 여부를 먼저 정한다.

## 6. A-11: 예약·실행·파일·제공자 통합

| 검사 | 확인할 동작 |
| --- | --- |
| 실제 예약 | 미래 회차 등록→prewarm→정해진 회차 실행→DB 결과→조회. prewarm이 실제 수집을 미리 시작하지 않음 |
| 예약 수정·취소 | prewarm/claim/실행과 경합해도 오래된 버전의 새 결과를 게시하지 않음. 특정 회차 취소와 반복 기능 중지 구분 |
| 복구 | worker/Pod/API를 재시작해 lease 회수·한도 있는 재시도·원래 scheduled_at 시간 문맥·이벤트 재접속 확인 |
| 채팅 | durable 접수→SSE 연결 종료/재접속→완료·취소→실제 리소스 조회. 숨겨진 추론을 UI에 노출하지 않음 |
| 문서 | 대표 DOCX/XLSX/PDF/TXT/CSV/HWP/HWPX 업로드·읽기·편집/지원 변환·다운로드·취소/재시도 |
| 글꼴/제한 | Linux subprocess CPU/메모리·크기 제한, 한글 PDF 실제 렌더, 병합 셀·표·콘텐츠 컨트롤·표시 필드 보존 |
| 검색·뉴스 | 실제 도구 호출, 출처, 엔진 제한·요약 실패·중단 refresh 복구·이전 성공 결과 stale 표시 |
| 주가 | 실제 KIS 권한, 당일 완료 1분봉과 일봉·종가 구분, 빈 장·휴장·provider 제한. 특수 개장일/시간 외는 후속 |
| 결제 | 테스트 상점 승인·응답 유실/조회·재전달 webhook·갱신·기간 말 해지·권한 만료·관리자 승인 보존 |
| Push/음성 | 브라우저 허용→실제 전송/표시, 전사→편집→사용자 제출. 발송 성공과 기기 수신·표시는 구분 |

정상 HWP 원본 전체 추출과 HWPX의 대표 실제 원본 인수는 기존 제어 fixture 검사와 별개로 남아 있다. 임의 서식 보존 편집, OCR, Excel 수식 재계산, HWP 편집을 지원한 것으로 표시하지 않는다. 앱 APNs/FCM·OS 위젯·IAP는 Web Push·Toss 구현에 포함되지 않는다.

## 7. 용량·관측·복구 결정

- warm/cold 기동 p50·p95, 이미지 미캐시·PVC 재부착 시간, 첫 토큰·전체 추론·수집/문서 소요를 분리한다. 과거 한 번의 약 11초 관찰을 p95로 쓰지 않는다.
- API/worker/provisioner·공용 부모/자식·Pro Pod의 CPU/RAM, DB 파일 바이트·WAL/백업 증가, local-path 물리 사용량, GPU 대기열과 사용자 지연을 함께 기록한다.
- 현재 자식 수·프로필 수·prewarm 동시 4·PVC 5Gi·requests/limits는 시작 정책이다. 프로필 검사와 PVC 요청은 물리 디스크 hard quota가 아니며 운영 경보가 필요하다.
- GPU 추론이 막혀도 저장된 기록 조회·정해진 단순 알림이 함께 막히지 않는지 확인한다. 전역 공정 대기·처리량 한도·요금제 quota의 제품 기준은 실측 뒤 정한다.
- DB에는 제품 기록과 원본/결과 파일 바이트가 있고 Hermes home에는 사용자별 실행 상태가 있다. 둘과 암호화 키를 일관된 복원 계획에 포함한다. 복구 시 미실행·불명확 외부 효과를 대조한다.
- 유휴 종료·Pro 회수 때 PVC를 삭제하지 않는다. Free↔Pro home 자동 이전·계정 탈퇴/보존기한·파일 파기·백업 만료·법적 보관 정책은 별도 확정/구현 작업이다.
- 단일 가정 LAN·단일 k3s 제어 평면·GPU 장비 장애는 독립 고가용성이 아니다. 노트북 절전·eGPU 분리·정전·공유기 장애와 복구를 확인하고, 측정 없이 가용성/SLO 숫자를 약속하지 않는다.

## 8. 근거와 추적 기준

아래는 해당 커밋의 고정 원문이다. `plan` 안에 backend/infra 코드를 복사하지 않고 현황과 인수 항목만 유지한다.

- [Backend 0.9와 최종 검증](https://github.com/dong7314/mori/blob/6285abac905b242442cceda103c63e18d8900ab3/backend/docs/poc-backend-0.9.md)
- [개인 Knative 배정·회수](https://github.com/dong7314/mori/blob/6285abac905b242442cceda103c63e18d8900ab3/infra/k3s/runtime-provisioning.md)
- [Free 공유 gateway 경계·배포](https://github.com/dong7314/mori/blob/6285abac905b242442cceda103c63e18d8900ab3/infra/k3s/shared-gateway.md)
- [일반 worker YAML](https://github.com/dong7314/mori/blob/6285abac905b242442cceda103c63e18d8900ab3/infra/k3s/backend-worker.yaml)
- [runtime provisioner YAML](https://github.com/dong7314/mori/blob/6285abac905b242442cceda103c63e18d8900ab3/infra/k3s/runtime-provisioner.yaml)
- [개인 런타임 ingress 정책](https://github.com/dong7314/mori/blob/6285abac905b242442cceda103c63e18d8900ab3/infra/k3s/runtime-network-policy.yaml)
- [웹/RN 독립 release 설계](app-release-versioning.md)
- [9월 단일 사용자 콜드 스타트 실험 기록](hermes-knative-validation-2026-09-29.md)
