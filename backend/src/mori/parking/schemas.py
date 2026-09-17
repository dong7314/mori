from typing import Annotated, Self
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, StringConstraints, model_validator

Floor = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=1, max_length=32, pattern=r"^[^\x00-\x1f\x7f]+$"
    ),
]
LocationPart = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=1, max_length=64, pattern=r"^[^\x00-\x1f\x7f]+$"
    ),
]


class ParkingCreate(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={"examples": [{"floor": "B2", "zone": "C", "spot": "C36"}]},
    )

    floor: Floor | None = None
    zone: LocationPart | None = None
    spot: LocationPart | None = None

    @model_validator(mode="after")
    def require_location(self) -> Self:
        if self.floor is None and self.zone is None and self.spot is None:
            raise ValueError("층, 구역, 자리 번호 중 하나 이상을 입력해 주세요.")
        return self


class ParkingRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    floor: str | None
    zone: str | None
    spot: str | None
    recorded_at: AwareDatetime
