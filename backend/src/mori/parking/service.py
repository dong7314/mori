import hashlib
import json
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from mori.errors import ApiError
from mori.parking.models import ParkingRecord
from mori.parking.schemas import ParkingCreate


def save_parking(
    session: Session, user_id: UUID, payload: ParkingCreate, idempotency_key: UUID
) -> tuple[ParkingRecord, bool]:
    values = payload.model_dump()
    request_hash = hashlib.sha256(
        json.dumps(values, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    # The unique constraint arbitrates concurrent retries across processes/Pods.
    record = session.scalar(
        insert(ParkingRecord)
        .values(
            user_id=user_id,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            **values,
        )
        .on_conflict_do_nothing(constraint="uq_parking_user_idempotency")
        .returning(ParkingRecord)
    )
    if record is not None:
        session.commit()
        return record, True

    # READ COMMITTED sees the winning transaction after ON CONFLICT has waited for it.
    record = session.scalar(
        select(ParkingRecord).where(
            ParkingRecord.user_id == user_id,
            ParkingRecord.idempotency_key == idempotency_key,
        )
    )
    if record is None:
        raise ApiError(503, "RETRY_REQUEST", "같은 요청 키로 다시 시도해 주세요.")
    if record.request_hash != request_hash:
        raise ApiError(409, "IDEMPOTENCY_CONFLICT", "이미 다른 내용에 사용한 요청 키입니다.")
    return record, False


def latest_parking(session: Session, user_id: UUID) -> ParkingRecord:
    record = session.scalar(
        select(ParkingRecord)
        .where(ParkingRecord.user_id == user_id)
        .order_by(ParkingRecord.recorded_at.desc(), ParkingRecord.id.desc())
        .limit(1)
    )
    if record is None:
        raise ApiError(404, "PARKING_NOT_FOUND", "아직 저장한 주차 위치가 없습니다.")
    return record
