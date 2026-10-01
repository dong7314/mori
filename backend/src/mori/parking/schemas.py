from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from mori.organizer.schemas import Clock, valid_zone

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


class ParkingDisplaySchedule(BaseModel):
    model_config = ConfigDict(extra="forbid")
    time: Clock
    timezone: str = Field(default="Asia/Seoul", max_length=64)
    days: list[int] = Field(default_factory=lambda: [0, 1, 2, 3, 4], min_length=1, max_length=7)
    duration_minutes: int = Field(default=90, ge=1, le=1440)

    _zone = field_validator("timezone")(valid_zone)

    @field_validator("days", mode="before")
    @classmethod
    def weekdays(cls, value):
        if (
            not isinstance(value, list)
            or not value
            or any(type(day) is not int or day < 0 or day > 6 for day in value)
        ):
            raise ValueError("Weekdays use Monday=0 through Sunday=6, without duplicates")
        if len(set(value)) != len(value):
            raise ValueError("Duplicate weekday")
        return sorted(value)


class ParkingCreate(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={"examples": [{"floor": "B2", "zone": "C", "spot": "C36"}]},
    )

    floor: Floor | None = None
    zone: LocationPart | None = None
    spot: LocationPart | None = None
    purpose: Literal["commute", "external"] = "external"
    display_mode: Literal["always", "scheduled"] = "always"
    display_schedule: ParkingDisplaySchedule | None = None

    @model_validator(mode="after")
    def require_location(self) -> Self:
        if self.floor is None and self.zone is None and self.spot is None:
            raise ValueError("층, 구역, 자리 번호 중 하나 이상을 입력해 주세요.")
        if (self.display_mode == "scheduled") != (self.display_schedule is not None):
            raise ValueError("Scheduled display requires a time; always display omits it")
        return self


class ParkingRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    floor: str | None
    zone: str | None
    spot: str | None
    recorded_at: AwareDatetime
    purpose: Literal["commute", "external"]
    display_mode: Literal["always", "scheduled"]
    display_schedule: ParkingDisplaySchedule | None
