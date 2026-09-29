# 2026-09-29 — 정식 런타임 배포와 Hermes 콜드 스타트 현장 기록

[전체 계획](../plan.md) · [채팅 구현](../back/chat-implementation-2026-09-29.md)

이 문서는 사용자가 대화에 제공한 서버 출력과 `master` 코드 이력을 구분해 기록한다.
이번 문서 갱신에서 서버에 접속하거나 클러스터를 변경하지 않았다.

## 확인한 과정

1. Harbor 프로젝트 미생성으로 이미지 push 401이 발생했고 프로젝트 준비 후 해결됐다.
2. 큰 레이어 push에서 499가 반복됐다. Traefik 3.5.1의 websecure readTimeout을
   HelmChartConfig로 600초 설정한 뒤 사용자가 push 성공을 보고했다.
   `/var/lib/rancher/k3s/server/manifests/traefik-config.yaml`은 유지할 운영 설정이다.
3. Git 기반 SearXNG 배포 후 Google/Naver 이미지 엔진의 URL·출처 반환을 확인했다.
4. 공용 Hermes 일반 Deployment의 worker Running, 5Gi PVC Bound, Service 8642와
   인증 health/toolsets/401 검사, 검색/본문 추출 모델 호출이 통과했다.
5. Google CAPTCHA는 일부 시험에서 발생했다. Brave/Naver 결과로 검색이 가능한 것을 확인했다.
   검색 성공을 모든 엔진의 지속 가용성이나 정보 정확성 보장으로 확대하지 않는다.
6. 실제 Hermes를 Knative로 전환했다. 사용자 출력에서 Pod 0개 → 인증된 Route 요청 성공 →
   새 Pod 2/2 Running을 확인했다. 요청부터 health 응답까지 관측값은 **11.69초, 11.19초**다.
7. 초기 scale-down에서 hermes exit 1, queue-proxy exit 0이 관측됐다.
   `master` `693ad03`의 lifecycle 수정 후 사용자 출력은 **Completed,Completed / 0,0**이다.

## 이미지와 종료 처리

`693ad03`은 dumb-init의 단일 자식 실행과 SIGTERM→SIGINT 전달로 Hermes gateway를
종료하도록 수정했다. 로컬 `mori-hermes:0.1.1` lifecycle 검사는 정상 종료·재시작,
비정상 종료 코드 보존을 확인했다. 현장에서도 위 정상 종료 출력이 확인됐다.
종료 오류 코드를 무조건 성공으로 바꾸는 방식은 아니다.

같은 Knative Revision/Deployment에서 교체된 Pod 이름과 사용자의 적용 결과를 기록한 것이며,
이 문서에서 현재 실행 중인 이미지 digest를 새로 조회한 것은 아니다. 운영 digest는 서버 manifest와
Harbor 출력으로 확인하고 고정한다.

## 확인 범위와 한계

- 내부 Route: `http://mori-hermes-knative.mori.svc.cluster.local`.
- 별도 일반 Deployment와 Knative Service를 동시에 활성화해 같은 home에 쓰지 않는다.
- 보조 client Pod는 Route로 요청을 보내는 시험 도구다. 별도 Hermes 인스턴스나 상시 prewarm 서비스가 아니다.
- health cold start 11초대는 전체 LLM 답변 지연이나 p95가 아니다. 새 노드의 이미지 pull/PVC 상태에 따라 달라진다.
- 예약 cron이 HTTP 유휴 판단과 무관하게 안전하게 끝까지 수행되는지, 사전 기동 후 Pod 유지와
  작업 중 scale-down 방지, 누락·중복 실행 정책은 아직 검증하지 않았다.
- Pro 개인 Service/PVC 자동 생성과 다중 사용자 공용 home 격리는 미구현이다.
- 새 Mori 채팅 API는 코드/로컬 검증 단계이며 실제 서버 통합은 다음 단계다.

## 예약 작업의 합의된 후속 방향 — 아직 미구현

Hermes가 예약 작업 내용과 자체 스케줄을 영속 home에 보관하고 실행한다.
Mori의 항상 실행되는 scheduler/worker는 사용자·runtime·Hermes job ID·다음 실행 시각·
prewarm 시각·버전·활성 여부 등 기동용 메타데이터를 보관한다.
예약 등록/수정/삭제 시 이 정보를 신뢰할 수 있는 도구/API 계약으로 동기화한다.
프롬프트만으로 동기화나 실행을 보장하지 않는다.

Mori는 예정 시각 전에 Route에 요청해 깨우고, 실행 준비부터 완료 callback까지 runtime이
유지되도록 제어해야 한다. health 한 번 호출 후 바로 연결을 닫는 것만으로 예약 실행을 보장하지 않는다.
예약 내용의 실행 주체를 양쪽에 중복 구현하지 않으며 회차 키/실행 lease/지연 처리/재시작 복구를
설계·검증한다. 구체적인 Knative 유지 수단과 cron 프로세스 실행 방식은 아직 선정·실증 전이다.
단순 주차 카드 표시는 DB 조회·시간대 규칙으로 처리하며 매번 Hermes를 기동하지 않는다.
