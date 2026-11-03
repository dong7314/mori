"""Mori's trusted, profile-isolating front door for a shared Hermes Pod.

Each UUID gets a separate process and HOME/HERMES_HOME. This is logical profile
isolation for search-only workers, not a sandbox for arbitrary user code.
"""

import asyncio
import hmac
import json
import logging
import os
import re
import secrets
import signal
import socket
import time
from dataclasses import dataclass, field
from pathlib import Path
from uuid import UUID

import aiohttp
import yaml
from aiohttp import web

LOG = logging.getLogger(__name__)
MAX_BODY = 1_000_000
MAX_RESPONSE = 2_000_000
TOOLS = {"web_search", "web_extract", "mori_image_search"}


def validate_base_environment(project=Path("/opt/hermes"), managed=Path("/etc/hermes")):
    # Pinned Hermes dotenv loading falls back to its checkout and managed scope.
    # Neither may override the distinct child keys, ports or home configuration.
    for path in (project / ".env", managed / ".env", managed / "config.yaml"):
        if path.exists() or path.is_symlink():
            raise ValueError("Shared gateway forbids global Hermes config/environment overrides")


async def read_bounded(response):
    result = bytearray()
    async for chunk in response.content.iter_chunked(16384):
        result.extend(chunk)
        if len(result) > MAX_RESPONSE:
            raise GatewayError(502, "PROFILE_INVALID_RESPONSE")
    return bytes(result)


class GatewayError(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code
        super().__init__(code)


def canonical_user(value):
    try:
        parsed = UUID(value)
    except (ValueError, TypeError, AttributeError) as exc:
        raise GatewayError(400, "INVALID_USER_CONTEXT") from exc
    if str(parsed) != value:
        raise GatewayError(400, "INVALID_USER_CONTEXT")
    return str(parsed)


def validate_request(value):
    allowed = {"input", "conversation_history", "instructions", "store", "stream"}
    if not isinstance(value, dict) or set(value) - allowed:
        raise GatewayError(422, "INVALID_AGENT_REQUEST")
    if value.get("store") is not False or value.get("stream") is not True:
        raise GatewayError(422, "STATELESS_STREAM_REQUIRED")
    if not isinstance(value.get("input"), str) or not 1 <= len(value["input"]) <= 24000:
        raise GatewayError(422, "INVALID_AGENT_REQUEST")
    if (
        not isinstance(value.get("instructions", ""), str)
        or len(value.get("instructions", "")) > 256000
    ):
        raise GatewayError(422, "INVALID_AGENT_REQUEST")
    history = value.get("conversation_history", [])
    if not isinstance(history, list) or len(history) > 200:
        raise GatewayError(422, "INVALID_AGENT_REQUEST")
    for item in history:
        if (
            not isinstance(item, dict)
            or set(item) - {"role", "content"}
            or item.get("role") not in ("user", "assistant")
            or not isinstance(item.get("content"), str)
            or len(item["content"]) > 24000
        ):
            raise GatewayError(422, "INVALID_AGENT_REQUEST")
    return value


def validate_toolsets(value):
    rows = value.get("data") if isinstance(value, dict) else None
    if not isinstance(rows, list):
        raise GatewayError(503, "PROFILE_TOOL_POLICY")
    available = set()
    for row in rows:
        if not isinstance(row, dict):
            raise GatewayError(503, "PROFILE_TOOL_POLICY")
        if row.get("enabled"):
            names = row.get("tools")
            if (
                row.get("name") not in {"web", "mori_images"}
                or not isinstance(names, list)
                or any(not isinstance(name, str) or name not in TOOLS for name in names)
            ):
                raise GatewayError(503, "PROFILE_TOOL_POLICY")
            if row.get("configured") is True:
                available.update(names)
    if not {"web_search", "web_extract"}.issubset(available):
        raise GatewayError(503, "PROFILE_TOOL_POLICY")


@dataclass
class Config:
    root: Path
    template: Path
    plugins: Path
    key: str
    child_command: str = "/opt/hermes/.venv/bin/hermes"
    max_processes: int = 4
    idle_seconds: int = 180
    startup_seconds: int = 90
    shutdown_seconds: int = 30
    profile_max_bytes: int = 100_000_000
    max_profiles: int = 40

    def validate(self):
        if len(self.key) < 32 or any(ord(c) < 33 or ord(c) > 126 for c in self.key):
            raise ValueError(
                "Shared gateway requires a server-only random key of at least 32 characters"
            )
        if not 1 <= self.max_processes <= 32 or not 10 <= self.idle_seconds <= 3600:
            raise ValueError("Invalid process bounds")
        if not 1 <= self.startup_seconds <= 300 or not 1 <= self.shutdown_seconds <= 60:
            raise ValueError("Invalid lifecycle bounds")
        if (
            not 1 <= self.max_profiles <= 100000
            or not 1_000_000 <= self.profile_max_bytes <= 1_000_000_000
        ):
            raise ValueError("Invalid profile storage bounds")
        if self.root.is_symlink():
            raise ValueError("Profile root cannot be a symlink")
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root = self.root.resolve()
        if not self.template.is_file():
            raise ValueError("Trusted shared config missing")


def profile_config(config, home, port):
    """Do not copy another user's .env, memory, sessions, API key, or profile state."""
    source_config = yaml.safe_load(config.template.read_text())
    if not isinstance(source_config, dict) or b"REPLACE_" in config.template.read_bytes():
        raise ValueError("Invalid trusted config")
    # Copy only model/search settings, never arbitrary MCP servers, hooks, cron,
    # channels, shell configuration or other extension settings from a template.
    template = {
        key: source_config[key] for key in ("providers", "model", "web") if key in source_config
    }
    template["gateway"] = {"multiplex_profiles": False}
    template["platform_toolsets"] = {"api_server": ["web", "mori_images"]}
    template["plugins"] = {"enabled": ["mori_images", "mori_extract"]}
    template["platforms"] = {"api_server": {"enabled": True, "host": "127.0.0.1", "port": port}}
    # Only these two immutable image plugins can be discovered in a tenant home.
    target = home / "plugins"
    if target.is_symlink():
        raise ValueError("Profile plugin directory is a symlink")
    target.mkdir(mode=0o700, exist_ok=True)
    for name in ("mori_images", "mori_extract"):
        source = (config.plugins / name).resolve()
        if not (source / "plugin.yaml").is_file():
            raise ValueError("Image plugin missing")
        link = target / name
        if link.is_symlink():
            if link.resolve() != source:
                raise ValueError("Unexpected profile plugin")
        elif link.exists():
            raise ValueError("Unmanaged profile plugin")
        else:
            link.symlink_to(source, target_is_directory=True)
    if set(p.name for p in target.iterdir()) != {"mori_images", "mori_extract"}:
        raise ValueError("Additional profile plugin forbidden")
    destination = home / "config.yaml"
    if destination.is_symlink():
        raise ValueError("Profile config is a symlink")
    temporary = home / (".config-" + secrets.token_hex(8))
    try:
        with temporary.open("x") as stream:
            yaml.safe_dump(template, stream, allow_unicode=True, sort_keys=False)
        temporary.chmod(0o600)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return template


def build_environment(config, home, port, key, template):
    allowed = {"LANG", "LC_ALL", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "SEARXNG_URL"}
    for provider in template.get("providers", {}).values():
        name = provider.get("key_env") if isinstance(provider, dict) else None
        if isinstance(name, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,100}", name):
            if name not in {"API_SERVER_KEY", "MORI_SHARED_GATEWAY_KEY"}:
                allowed.add(name)
    env = {name: os.environ[name] for name in allowed if name in os.environ}
    env.update(
        {
            "PATH": "/opt/hermes/.venv/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": str(home),
            "HERMES_HOME": str(home),
            "XDG_CONFIG_HOME": str(home / ".config"),
            "XDG_STATE_HOME": str(home / ".state"),
            "XDG_CACHE_HOME": str(home / ".cache"),
            "TMPDIR": str(home / "tmp"),
            "API_SERVER_ENABLED": "true",
            "API_SERVER_HOST": "127.0.0.1",
            "API_SERVER_PORT": str(port),
            "API_SERVER_KEY": key,
            "HERMES_GATEWAY_NO_SUPERVISE": "1",
            "HERMES_DISABLE_LAZY_INSTALLS": "1",
            "HERMES_WRITE_SAFE_ROOT": str(home),
            "HERMES_LAZY_INSTALL_TARGET": str(home / "lazy-packages"),
            "PYTHONDONTWRITEBYTECODE": "1",
        }
    )
    return env


def check_profile(config, user):
    home = config.root / user
    if home.is_symlink() or (home.exists() and not home.is_dir()):
        raise GatewayError(503, "PROFILE_INVALID")
    if not home.exists():
        if sum(1 for path in config.root.iterdir() if path.is_dir()) >= config.max_profiles:
            raise GatewayError(503, "PROFILE_CAPACITY")
        home.mkdir(mode=0o700)
    if home.resolve().parent != config.root:
        raise GatewayError(503, "PROFILE_INVALID")
    # Never follow user-created links while accounting or traversing the profile.
    total = count = 0
    for folder, dirs, files in os.walk(home, followlinks=False):
        for name in dirs + files:
            path = Path(folder) / name
            if path.is_symlink():
                if (
                    path.parent != home / "plugins"
                    or name not in {"mori_images", "mori_extract"}
                    or path.resolve() != (config.plugins / name).resolve()
                ):
                    raise GatewayError(503, "PROFILE_INVALID")
        dirs[:] = [name for name in dirs if not (Path(folder) / name).is_symlink()]
        count += len(dirs)
        if count > 20000:
            raise GatewayError(503, "PROFILE_QUOTA")
        for name in files:
            path = Path(folder) / name
            if path.is_symlink():
                continue
            count += 1
            try:
                total += path.stat().st_size
            except FileNotFoundError:
                continue  # A running worker may rotate its own logs.
            if count > 20000 or total > config.profile_max_bytes:
                raise GatewayError(503, "PROFILE_QUOTA")
    # The child receives credentials only through its isolated environment.
    if any((home / name).exists() for name in (".env", ".op.env")):
        raise GatewayError(503, "PROFILE_INVALID")
    (home / "tmp").mkdir(mode=0o700, exist_ok=True)
    return home


@dataclass
class Child:
    user: str
    home: Path
    port: int
    key: str
    process: object
    active: int = 0
    last_used: float = field(default_factory=time.monotonic)
    ready: asyncio.Task | None = None
    request_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    invalid: bool = False


class ProcessPool:
    def __init__(self, config, *, launcher=None, waiter=None):
        config.validate()
        self.config = config
        self.children = {}
        self.lock = asyncio.Lock()
        self.launcher = launcher or self.launch
        self.waiter = waiter or self.wait_ready
        self.closed = False

    async def launch(self, home, port, key):
        template = profile_config(self.config, home, port)
        env = build_environment(self.config, home, port, key, template)
        # No main-wrapper: it intentionally overwrites HOME with /opt/data.
        return await asyncio.create_subprocess_exec(
            self.config.child_command,
            "gateway",
            "run",
            cwd=home,
            env=env,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            start_new_session=True,
        )

    async def wait_ready(self, child):
        deadline = time.monotonic() + self.config.startup_seconds
        timeout = aiohttp.ClientTimeout(total=3)
        async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as client:
            while time.monotonic() < deadline:
                if child.process.returncode is not None:
                    raise GatewayError(503, "PROFILE_START_FAILED")
                try:
                    async with client.get(
                        f"http://127.0.0.1:{child.port}/v1/toolsets",
                        headers={"Authorization": "Bearer " + child.key},
                        allow_redirects=False,
                    ) as response:
                        if response.status == 200:
                            body = await read_bounded(response)
                            validate_toolsets(json.loads(body))
                            return
                except (aiohttp.ClientError, TimeoutError, ValueError):
                    pass
                await asyncio.sleep(0.25)
        raise GatewayError(503, "PROFILE_START_TIMEOUT")

    async def stop(self, child):
        try:
            if child.ready and not child.ready.done():
                child.ready.cancel()
                await asyncio.gather(child.ready, return_exceptions=True)
            if child.process.returncode is None:
                try:
                    child.process.send_signal(signal.SIGINT)
                except ProcessLookupError:
                    pass
                try:
                    await asyncio.wait_for(child.process.wait(), self.config.shutdown_seconds)
                except TimeoutError:
                    pass
        finally:
            # Extract workers share the child's process group. Even a parent
            # that exits promptly (or already crashed) can leave them running.
            try:
                if getattr(child.process, "pid", None):
                    os.killpg(child.process.pid, signal.SIGKILL)
                elif child.process.returncode is None:
                    child.process.kill()
            except ProcessLookupError:
                pass
            await child.process.wait()

    async def acquire(self, user):
        user = canonical_user(user)
        async with self.lock:
            if self.closed:
                raise GatewayError(503, "GATEWAY_STOPPING")
            child = self.children.get(user)
            if child and child.process.returncode is not None:
                await self.stop(child)
                del self.children[user]
                child = None
            if child is None:
                victim = None
                if len(self.children) >= self.config.max_processes:
                    idle = [c for c in self.children.values() if c.active == 0]
                    if not idle:
                        raise GatewayError(503, "SHARED_CAPACITY")
                    victim = min(idle, key=lambda c: c.last_used)
                home = check_profile(self.config, user)
                if victim is not None:
                    await self.stop(victim)
                    del self.children[victim.user]
                with socket.socket() as socket_:
                    socket_.bind(("127.0.0.1", 0))
                    port = socket_.getsockname()[1]
                key = secrets.token_urlsafe(48)
                try:
                    process = await self.launcher(home, port, key)
                except (OSError, ValueError) as exc:
                    LOG.warning("Shared profile launch failed (%s)", type(exc).__name__)
                    raise GatewayError(503, "PROFILE_START_FAILED") from exc
                child = Child(user, home, port, key, process)
                self.children[user] = child
                child.ready = asyncio.create_task(self.waiter(child))
            else:
                check_profile(self.config, user)
            child.active += 1
            child.last_used = time.monotonic()
        try:
            await asyncio.shield(child.ready)
            return child
        except BaseException:
            await self.release(child)
            if child.ready.done() and not child.ready.cancelled() and child.ready.exception():
                await self.invalidate(child)
            raise

    async def invalidate(self, child):
        async with self.lock:
            if self.children.get(child.user) is child:
                child.invalid = True
                await self.stop(child)
                del self.children[child.user]

    async def release(self, child):
        async with self.lock:
            child.active = max(0, child.active - 1)
            child.last_used = time.monotonic()

    async def reap(self):
        async with self.lock:
            now = time.monotonic()
            for user, child in list(self.children.items()):
                over_quota = False
                try:
                    check_profile(self.config, user)
                except GatewayError:
                    over_quota = True
                if over_quota or (
                    child.active == 0 and now - child.last_used >= self.config.idle_seconds
                ):
                    child.invalid = True
                    await self.stop(child)
                    del self.children[user]

    async def close(self):
        async with self.lock:
            self.closed = True
        deadline = time.monotonic() + self.config.shutdown_seconds
        while any(child.active for child in self.children.values()) and time.monotonic() < deadline:
            await asyncio.sleep(0.1)
        await asyncio.gather(*(self.stop(child) for child in self.children.values()))
        self.children.clear()


def create_app(config, *, pool=None):
    pool = pool or ProcessPool(config)

    @web.middleware
    async def errors(request, handler):
        try:
            if request.path != "/health":
                tokens = request.headers.getall("Authorization", [])
                if len(tokens) != 1 or not hmac.compare_digest(
                    tokens[0].encode(), ("Bearer " + config.key).encode()
                ):
                    raise GatewayError(401, "UNAUTHORIZED")
                if len(request.headers.getall("X-Mori-User-ID", [])) != 1:
                    raise GatewayError(400, "INVALID_USER_CONTEXT")
                canonical_user(request.headers.get("X-Mori-User-ID"))
            return await handler(request)
        except GatewayError as exc:
            return web.json_response(
                {"error": {"code": exc.code}},
                status=exc.status,
                headers={"Cache-Control": "no-store"},
            )
        except (aiohttp.ClientError, TimeoutError):
            return web.json_response({"error": {"code": "PROFILE_UNAVAILABLE"}}, status=503)

    app = web.Application(client_max_size=MAX_BODY, middlewares=[errors])

    async def health(request):
        return web.json_response(
            {"status": "ok", "profile_isolation": "process-home-v1"},
            status=503 if pool.closed else 200,
        )

    async def proxy(request):
        if request.query_string:
            raise GatewayError(422, "QUERY_NOT_ALLOWED")
        data = None
        if request.method == "POST":
            try:
                data = validate_request(await request.json())
            except (ValueError, UnicodeError) as exc:
                raise GatewayError(422, "INVALID_JSON") from exc
        child = await pool.acquire(request.headers["X-Mori-User-ID"])
        response = None
        owns_request = False
        try:
            await child.request_lock.acquire()
            owns_request = True
            if child.invalid or child.process.returncode is not None:
                raise GatewayError(503, "PROFILE_UNAVAILABLE")
            timeout = aiohttp.ClientTimeout(total=660, connect=5)
            async with aiohttp.ClientSession(timeout=timeout, trust_env=False) as client:
                async with client.request(
                    request.method,
                    f"http://127.0.0.1:{child.port}{request.path}",
                    json=data,
                    headers={"Authorization": "Bearer " + child.key},
                    allow_redirects=False,
                ) as upstream:
                    if upstream.status != 200:
                        raise GatewayError(503, "PROFILE_UNAVAILABLE")
                    content_type = upstream.headers.get("Content-Type", "")
                    expected = (
                        "text/event-stream" if request.method == "POST" else "application/json"
                    )
                    if expected not in content_type:
                        raise GatewayError(502, "PROFILE_INVALID_RESPONSE")
                    if request.method == "GET":
                        body = await read_bounded(upstream)
                        try:
                            validate_toolsets(json.loads(body))
                        except (ValueError, UnicodeError) as exc:
                            raise GatewayError(502, "PROFILE_INVALID_RESPONSE") from exc
                        return web.Response(
                            body=body,
                            content_type="application/json",
                            headers={"Cache-Control": "no-store"},
                        )
                    response = web.StreamResponse(
                        headers={
                            "Content-Type": expected,
                            "Cache-Control": "no-store",
                            "X-Accel-Buffering": "no",
                        }
                    )
                    await response.prepare(request)
                    total = 0
                    async for chunk in upstream.content.iter_chunked(16384):
                        total += len(chunk)
                        if total > MAX_RESPONSE:
                            raise GatewayError(502, "PROFILE_INVALID_RESPONSE")
                        await response.write(chunk)
                    await response.write_eof()
                    return response
        except BaseException as exc:
            # Disconnects must not leave an upstream job running in a process
            # considered idle/reusable. Waiting requests fail and can retry.
            if owns_request:
                child.invalid = True
                await pool.invalidate(child)
            if response is not None and response.prepared and isinstance(exc, Exception):
                response.force_close()
                if request.transport:
                    request.transport.close()
                return response
            raise
        finally:
            if owns_request:
                child.request_lock.release()
            await pool.release(child)

    async def lifecycle(app):
        async def reaper():
            while True:
                await asyncio.sleep(10)
                await pool.reap()

        task = asyncio.create_task(reaper())
        yield
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await pool.close()

    app.cleanup_ctx.append(lifecycle)
    app.router.add_get("/health", health)
    app.router.add_get("/v1/toolsets", proxy, allow_head=False)
    app.router.add_post("/v1/responses", proxy)
    return app


def main():
    validate_base_environment()
    config = Config(
        root=Path(os.getenv("MORI_SHARED_HOME_ROOT", "/opt/data/tenants")),
        template=Path(os.getenv("MORI_SHARED_CONFIG", "/bootstrap/config.yaml")),
        plugins=Path("/opt/mori/plugins"),
        key=os.environ["MORI_SHARED_GATEWAY_KEY"],
        max_processes=int(os.getenv("MORI_SHARED_MAX_PROCESSES", "4")),
        idle_seconds=int(os.getenv("MORI_SHARED_IDLE_SECONDS", "180")),
        profile_max_bytes=int(os.getenv("MORI_SHARED_PROFILE_MAX_BYTES", "100000000")),
        max_profiles=int(os.getenv("MORI_SHARED_MAX_PROFILES", "40")),
    )
    web.run_app(
        create_app(config),
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8642")),
        access_log=None,
        shutdown_timeout=25,
        handler_cancellation=True,
    )


if __name__ == "__main__":
    main()
