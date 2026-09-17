# 기존 k3s에 Mori API 배포

이 디렉터리는 배포 예시다. 기존 GPU·Hermes·클러스터를 수정하지 않는다. 실제 적용 전에 이미지 저장소와 PostgreSQL 연결 주소를 준비한다. PostgreSQL 배포·스토리지 정책은 이 첫 백엔드 구현에 포함하지 않는다.

## 적용 순서

1. `backend/Dockerfile`로 노드 아키텍처에 맞는 이미지를 빌드하고 클러스터에서 접근 가능한 레지스트리에 올린다. 배포 파일 두 곳의 `mori-backend:dev`를 같은 배포 태그나 digest로 바꾼다. 개발 PC의 Docker 이미지가 k3s 노드에 자동 공유되지는 않는다.
2. `mori` namespace와 PostgreSQL DB·접속 계정을 준비한다. 다른 서비스 DB를 재사용하지 않고 Mori용 DB를 사용한다.
3. `MORI_DATABASE_URL` 키를 가진 `mori-backend` Secret을 만든다. 비밀번호·실제 연결 문자열을 YAML이나 Git에 넣지 않는다.
4. `migrate.yaml`의 Job을 적용하고 성공을 확인한다.
5. `backend.yaml`의 Deployment·ClusterIP Service를 적용하고 준비 완료를 확인한다.
6. Pod에서 `mori create-user`로 알파 사용자를 만들고 API를 호출한다.

예를 들어 로컬의 **Git에서 제외한** `backend/.env`에 운영 DB 연결 문자열만 준비한 경우:

```sh
kubectl create namespace mori
kubectl -n mori create secret generic mori-backend --from-env-file=backend/.env
kubectl apply -f infra/k3s/migrate.yaml
kubectl -n mori wait --for=condition=complete job/mori-migrate-0001 --timeout=120s
kubectl apply -f infra/k3s/backend.yaml
kubectl -n mori rollout status deployment/mori-api
kubectl -n mori exec deployment/mori-api -- mori create-user --name "개인 알파"
kubectl -n mori port-forward service/mori-api 8000:8000
```

마이그레이션이 실패하면 새 API 배포를 진행하지 않는다. 다음 릴리스에서는 마이그레이션 Job 이름을 바꾸고, 동시 마이그레이션은 실행하지 않는다. 모든 Pod의 시작 명령에 마이그레이션을 붙이지 않는다.

## 운영 설정

- API는 무상태이며 복제본 1개로 시작한다. PostgreSQL의 고유 제약으로 여러 API 프로세스에서의 중복 저장도 방지한다.
- CPU·메모리 값은 시작용 예시다. 실제 부하에서 조정한다.
- API에는 Kubernetes 관리 권한을 부여하지 않는다.
- readiness는 DB·스키마 접근, liveness는 프로세스를 확인한다.
- Service는 내부용이다. 외부 공개 시 Mori API에 TLS Ingress를 연결하고 실제 앱 origin을 `MORI_CORS_ORIGINS`에 설정한다.
- 초기 마이그레이션은 테이블 생성 권한이 필요하다. 운영 시 마이그레이션 계정과 API의 제한된 DML 계정 분리를 권한다. 그 경우 Job과 Deployment가 각각 다른 Secret을 참조하도록 바꾼다.
- DB 백업과 사용자 토큰 관리는 애플리케이션 Pod의 수명과 분리한다.

Hermes Pod와 에이전트 전용 인증·작업 큐는 다음 구현 범위다.
