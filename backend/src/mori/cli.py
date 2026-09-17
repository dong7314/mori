import argparse
import json
from uuid import UUID

from sqlalchemy import delete, func

from mori.auth.models import AuthSession, LoginGrant, OAuthFlow
from mori.auth.sessions import revoke_session
from mori.config import Settings
from mori.database import build_engine, build_session_factory


def main() -> None:
    parser = argparse.ArgumentParser(description="Mori 인증 세션 운영 도구 (가입·토큰 발급 없음)")
    commands = parser.add_subparsers(dest="command", required=True)
    revoke = commands.add_parser("revoke-session", help="로그인 세션 폐기")
    revoke.add_argument("--session-id", required=True, type=UUID)
    commands.add_parser("prune-auth", help="만료된 로그인 요청·교환 코드·세션 정리")
    args = parser.parse_args()
    engine = build_engine(Settings())
    try:
        with build_session_factory(engine)() as session:
            if args.command == "revoke-session":
                revoke_session(session, args.session_id)
                output = {"session_id": str(args.session_id), "revoked": True}
            else:
                output = {}
                for model in (OAuthFlow, LoginGrant, AuthSession):
                    result = session.execute(delete(model).where(model.expires_at <= func.now()))
                    output[model.__tablename__] = result.rowcount
                # Used refresh tokens stay until the whole session expires (replay detection).
                session.commit()
        print(json.dumps(output, ensure_ascii=False))
    finally:
        engine.dispose()
