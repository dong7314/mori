import base64
import hashlib
import secrets


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def opaque_token(prefix: str = "") -> str:
    return prefix + secrets.token_urlsafe(32)


def pkce_challenge(verifier: str) -> str:
    return (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest())
        .rstrip(b"=")
        .decode()
    )
