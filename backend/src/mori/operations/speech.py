"""Authenticated bounded adapter for a configured Whisper-compatible transcription server."""

import asyncio
import json
from typing import Annotated, Literal

import httpx
from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field

from mori.auth.dependencies import CurrentUser
from mori.errors import PRIVATE_API_RESPONSES, ApiError, ErrorResponse

router = APIRouter(
    prefix="/v1/speech",
    tags=["speech"],
    responses={
        **PRIVATE_API_RESPONSES,
        **{status: {"model": ErrorResponse} for status in (413, 415, 502, 504)},
    },
)
TYPES = {
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
}


class TranscriptionRead(BaseModel):
    text: str = Field(min_length=1, max_length=40000)
    language: str
    sent_to_chat: Literal[False] = False


def get_speech_transport():
    return None


Transport = Annotated[httpx.AsyncBaseTransport | None, Depends(get_speech_transport)]


async def transcribe(settings, content, media_type, language, *, transport=None):
    if not settings.speech_base_url:
        raise ApiError(503, "SPEECH_NOT_CONFIGURED", "음성 인식 서버가 설정되지 않았습니다.")
    headers = {}
    if settings.speech_api_key.get_secret_value():
        headers["Authorization"] = "Bearer " + settings.speech_api_key.get_secret_value()
    try:
        async with (
            asyncio.timeout(65),
            httpx.AsyncClient(
                transport=transport, trust_env=False, follow_redirects=False
            ) as client,
        ):
            async with client.stream(
                "POST",
                settings.speech_base_url + "/v1/audio/transcriptions",
                headers=headers,
                files={"file": ("audio." + TYPES[media_type], content, media_type)},
                data={
                    "model": settings.speech_model,
                    "language": language,
                    "response_format": "json",
                },
                timeout=httpx.Timeout(60, connect=5),
            ) as response:
                if response.status_code == 429:
                    raise ApiError(
                        503,
                        "SPEECH_PROVIDER_RATE_LIMITED",
                        "음성 인식 요청이 많습니다. 잠시 뒤 다시 시도해 주세요.",
                    )
                if response.status_code != 200:
                    raise ValueError("Provider failed")
                body = bytearray()
                async for part in response.aiter_bytes():
                    body.extend(part)
                    if len(body) > 200_000:
                        raise ValueError("Response too large")
                value = json.loads(body)
                if (
                    not isinstance(value, dict)
                    or not isinstance(value.get("text"), str)
                    or len(value["text"]) > 40000
                ):
                    raise ValueError("Invalid transcript")
                transcript = value["text"].strip()
                if not transcript:
                    raise ApiError(422, "NO_SPEECH", "말소리를 듣지 못했습니다. 다시 말해 주세요.")
                if any(ord(c) < 32 and c not in "\n\r\t" for c in transcript):
                    raise ValueError("Invalid transcript controls")
                # JSON may contain escaped lone surrogates that cannot be serialized
                # as a public UTF-8 response. Classify them at the provider boundary.
                transcript.encode("utf-8")
                return {"text": transcript, "language": language, "sent_to_chat": False}
    except (TimeoutError, httpx.TimeoutException) as exc:
        raise ApiError(504, "SPEECH_TIMEOUT", "음성 인식 시간이 초과되었습니다.") from exc
    except (httpx.HTTPError, ValueError, KeyError, TypeError, UnicodeError, RecursionError) as exc:
        raise ApiError(
            502, "SPEECH_PROVIDER_FAILED", "음성을 텍스트로 변환하지 못했습니다."
        ) from exc


@router.post(
    "/transcriptions",
    response_model=TranscriptionRead,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                media_type: {"schema": {"type": "string", "format": "binary"}}
                for media_type in TYPES
            },
        }
    },
)
async def transcription(
    request: Request,
    user: CurrentUser,
    transport: Transport,
    language: str = Query("ko", pattern=r"^[a-z]{2}$"),
):
    settings = request.app.state.settings
    if not settings.speech_base_url:
        raise ApiError(503, "SPEECH_NOT_CONFIGURED", "음성 인식 서버가 설정되지 않았습니다.")
    media_type = request.headers.get("content-type", "").split(";", 1)[0].lower()
    if media_type not in TYPES:
        raise ApiError(415, "UNSUPPORTED_AUDIO", "지원하지 않는 오디오 형식입니다.")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > settings.speech_max_bytes:
            raise ApiError(413, "AUDIO_TOO_LARGE", "음성 파일 크기를 초과했습니다.")
    if not body:
        raise ApiError(422, "EMPTY_AUDIO", "음성 파일이 비어 있습니다.")
    return await transcribe(settings, bytes(body), media_type, language, transport=transport)
