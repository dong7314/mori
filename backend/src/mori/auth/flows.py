from datetime import timedelta

from sqlalchemy import func, update
from sqlalchemy.orm import Session

from mori.auth.crypto import hash_token, opaque_token
from mori.auth.models import LoginGrant, OAuthFlow
from mori.auth.providers import VerifiedProfile, authorization_url
from mori.auth.schemas import Provider
from mori.auth.sessions import database_now
from mori.config import Settings
from mori.errors import ApiError

FLOW_SECONDS = 600
GRANT_SECONDS = 120


def cookie_name(state: str) -> str:
    return "mori_oauth_" + hash_token(state)[:16]


def start_flow(
    session: Session,
    settings: Settings,
    provider: Provider,
    return_url: str,
    code_challenge: str,
    client_state: str,
) -> tuple[str, str, str]:
    if return_url not in settings.auth_return_urls:
        raise ApiError(400, "INVALID_RETURN_URL", "허용되지 않은 로그인 복귀 주소입니다.")
    state, browser_secret = opaque_token(), opaque_token()
    url = authorization_url(settings, provider, state)
    session.add(
        OAuthFlow(
            state_hash=hash_token(state),
            provider=provider,
            browser_hash=hash_token(browser_secret),
            code_challenge=code_challenge,
            client_state=client_state,
            return_url=return_url,
            expires_at=database_now(session) + timedelta(seconds=FLOW_SECONDS),
        )
    )
    session.commit()
    return url, state, browser_secret


def consume_flow(
    session: Session, settings: Settings, provider: Provider, state: str, browser_secret: str | None
) -> OAuthFlow:
    if not browser_secret or len(browser_secret) > 256:
        raise ApiError(
            400, "INVALID_OAUTH_STATE", "로그인을 시작한 브라우저에서 다시 시도해 주세요."
        )
    flow = session.scalar(
        update(OAuthFlow)
        .where(
            OAuthFlow.state_hash == hash_token(state),
            OAuthFlow.provider == provider,
            OAuthFlow.browser_hash == hash_token(browser_secret),
            OAuthFlow.consumed_at.is_(None),
            OAuthFlow.expires_at > func.clock_timestamp(),
            OAuthFlow.return_url.in_(settings.auth_return_urls),
        )
        .values(consumed_at=func.clock_timestamp())
        .returning(OAuthFlow)
    )
    if flow is None:
        raise ApiError(400, "INVALID_OAUTH_STATE", "로그인 요청이 만료되었거나 유효하지 않습니다.")
    # Claim exactly once before the external code exchange. Uncertain failures need a fresh login.
    session.commit()
    return flow


def create_grant(session: Session, flow: OAuthFlow, profile: VerifiedProfile) -> str:
    code = opaque_token()
    session.add(
        LoginGrant(
            code_hash=hash_token(code),
            provider=profile.provider,
            subject=profile.subject,
            display_name=profile.display_name,
            code_challenge=flow.code_challenge,
            expires_at=database_now(session) + timedelta(seconds=GRANT_SECONDS),
        )
    )
    session.commit()
    return code
