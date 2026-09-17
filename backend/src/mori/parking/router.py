from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, Response, status

from mori.auth.dependencies import CurrentUser
from mori.database import DatabaseSession
from mori.errors import ErrorResponse
from mori.parking.schemas import ParkingCreate, ParkingRead
from mori.parking.service import latest_parking, save_parking

router = APIRouter(prefix="/v1/parking-records", tags=["parking"])
common_errors = {
    401: {"model": ErrorResponse, "description": "인증 누락·만료·폐기"},
    422: {"model": ErrorResponse, "description": "입력 또는 요청 키 형식 오류"},
    503: {"model": ErrorResponse, "description": "저장소 처리 실패"},
}


@router.post(
    "",
    response_model=ParkingRead,
    status_code=status.HTTP_201_CREATED,
    summary="내 주차 위치 저장",
    responses={
        **common_errors,
        200: {"model": ParkingRead, "description": "동일한 요청의 재전송"},
        409: {"model": ErrorResponse, "description": "같은 키에 다른 저장 내용"},
    },
)
def create_parking_record(
    payload: ParkingCreate,
    response: Response,
    user: CurrentUser,
    session: DatabaseSession,
    idempotency_key: Annotated[
        UUID,
        Header(
            alias="Idempotency-Key",
            description="저장 작업별 UUID. 통신 실패 후 재전송할 때는 같은 값을 사용합니다.",
        ),
    ],
) -> ParkingRead:
    record, created = save_parking(session, user.id, payload, idempotency_key)
    response.status_code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
    return ParkingRead.model_validate(record)


@router.get(
    "/latest",
    response_model=ParkingRead,
    summary="내 최신 주차 위치 조회",
    responses={
        **common_errors,
        404: {"model": ErrorResponse, "description": "저장한 기록이 없음"},
    },
)
def get_latest_parking_record(user: CurrentUser, session: DatabaseSession) -> ParkingRead:
    return ParkingRead.model_validate(latest_parking(session, user.id))
