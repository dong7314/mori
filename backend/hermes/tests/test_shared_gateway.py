import asyncio
import importlib.util
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import yaml
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location(
    "mori_shared_gateway", ROOT / "backend/hermes/shared_gateway.py"
)
gateway = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = gateway
spec.loader.exec_module(gateway)
TOOLSETS = {
    "data": [
        {
            "name": "web",
            "enabled": True,
            "configured": True,
            "tools": ["web_search", "web_extract"],
        },
        {
            "name": "mori_images",
            "enabled": True,
            "configured": True,
            "tools": ["mori_image_search"],
        },
    ]
}


class Process:
    def __init__(self):
        self.returncode = None
        self.signals = []

    def send_signal(self, sig):
        self.signals.append(sig)
        self.returncode = 0

    async def wait(self):
        return self.returncode

    def kill(self):
        self.returncode = -9


class SharedGatewayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.template = root / "template.yaml"
        self.template.write_text(
            yaml.safe_dump(
                {
                    "providers": {
                        "lan": {"api": "http://model.test/v1", "key_env": "LLAMA_API_KEY"}
                    },
                    "platforms": {"telegram": {"enabled": True}},
                    "platform_toolsets": {"api_server": ["terminal", "memory"]},
                    "gateway": {"multiplex_profiles": True},
                    "mcp_servers": {"unsafe": {"command": "sh"}},
                    "hooks": {"startup": "unsafe"},
                }
            )
        )
        plugins = root / "plugins"
        for name in ("mori_images", "mori_extract"):
            (plugins / name).mkdir(parents=True)
            (plugins / name / "plugin.yaml").write_text("name: " + name)
        self.config = gateway.Config(
            root / "tenants",
            self.template,
            plugins,
            "server-key-" + "x" * 40,
            max_processes=2,
            idle_seconds=10,
        )
        self.launched = []
        self.upstreams = []
        self.requests = []
        self.inputs = []
        self.toolsets = TOOLSETS
        self.stream_gate = asyncio.Event()
        self.stream_started = asyncio.Event()

        async def launch(home, port, key):
            template = gateway.profile_config(self.config, home, port)
            env = gateway.build_environment(self.config, home, port, key, template)
            self.launched.append((home, port, key, env))
            app = web.Application()

            async def answer(request):
                self.requests.append((home, dict(request.headers)))
                assert request.headers["Authorization"] == "Bearer " + key
                assert "X-Mori-User-ID" not in request.headers
                assert "X-Hermes-Session-Id" not in request.headers
                if request.path == "/v1/toolsets":
                    return web.json_response(self.toolsets)
                body = await request.json()
                self.inputs.append(body["input"])
                if body["input"] == "stream":
                    response = web.StreamResponse(
                        headers={
                            "Content-Type": "text/event-stream",
                            "X-Hermes-Session-Id": "secret-upstream-session",
                        }
                    )
                    await response.prepare(request)
                    await response.write(b'data: {"start": true}\n\n')
                    self.stream_started.set()
                    await self.stream_gate.wait()
                    await response.write(b'data: {"end": true}\n\n')
                    return response
                marker = home / "memory.txt"
                previous = marker.read_text() if marker.exists() else ""
                marker.write_text(body["input"])
                return web.Response(
                    text="data: " + json.dumps({"previous": previous, "home": home.name}) + "\n\n",
                    content_type="text/event-stream",
                )

            app.router.add_get("/v1/toolsets", answer)
            app.router.add_post("/v1/responses", answer)
            runner = web.AppRunner(app)
            await runner.setup()
            await web.TCPSite(runner, "127.0.0.1", port).start()
            self.upstreams.append(runner)
            return Process()

        self.pool = gateway.ProcessPool(self.config, launcher=launch)
        self.client = TestClient(TestServer(gateway.create_app(self.config, pool=self.pool)))
        await self.client.start_server()
        self.a, self.b = str(uuid4()), str(uuid4())

    async def asyncTearDown(self):
        self.stream_gate.set()
        await self.client.close()
        for runner in self.upstreams:
            await runner.cleanup()

    def headers(self, user):
        return {"Authorization": "Bearer " + self.config.key, "X-Mori-User-ID": user}

    async def send(self, user, text, **extras):
        return await self.client.post(
            "/v1/responses",
            headers=self.headers(user),
            json={
                "input": text,
                "instructions": "reply",
                "conversation_history": [],
                "store": False,
                "stream": True,
                **extras,
            },
        )

    async def test_users_have_distinct_process_homes_keys_and_memory(self):
        first = await self.send(self.a, "alice-private")
        self.assertEqual(first.status, 200)
        await first.read()
        other = await self.send(self.b, "bob-private")
        body = await other.text()
        self.assertNotIn("alice-private", body)
        again = await self.send(self.a, "alice-next")
        body = await again.text()
        self.assertIn("alice-private", body)
        self.assertNotIn("bob-private", body)
        self.assertEqual(len(self.launched), 2)
        self.assertNotEqual(self.launched[0][2], self.launched[1][2])
        for home, _port, key, env in self.launched:
            self.assertEqual(env["HOME"], str(home))
            self.assertEqual(env["HERMES_HOME"], str(home))
            self.assertEqual(env["API_SERVER_HOST"], "127.0.0.1")
            self.assertEqual(env["HERMES_DISABLE_LAZY_INSTALLS"], "1")
            self.assertEqual(env["HERMES_WRITE_SAFE_ROOT"], str(home))
            self.assertNotEqual(key, self.config.key)
            config = yaml.safe_load((home / "config.yaml").read_text())
            self.assertEqual(config["platform_toolsets"], {"api_server": ["web", "mori_images"]})
            self.assertEqual(set(config["platforms"]), {"api_server"})
            self.assertFalse(config["gateway"]["multiplex_profiles"])
            self.assertNotIn("mcp_servers", config)
            self.assertNotIn("hooks", config)

    async def test_auth_user_context_and_route_allowlist(self):
        self.assertEqual((await self.client.get("/health")).status, 200)
        self.assertEqual((await self.client.get("/v1/toolsets")).status, 401)
        self.assertEqual(
            (
                await self.client.get(
                    "/v1/toolsets", headers={"Authorization": "Bearer " + self.config.key}
                )
            ).status,
            400,
        )
        self.assertEqual(
            (await self.client.get("/v1/toolsets", headers=self.headers("../bob"))).status, 400
        )
        self.assertEqual(
            (await self.client.get("/api/sessions", headers=self.headers(self.a))).status, 404
        )
        self.assertEqual(
            (
                await self.client.get("/v1/toolsets?profile=bob", headers=self.headers(self.a))
            ).status,
            422,
        )
        self.assertEqual(
            (await self.client.head("/v1/toolsets", headers=self.headers(self.a))).status, 405
        )
        self.assertEqual(
            (await self.client.get("/v1/toolsets", headers=self.headers(self.a.upper()))).status,
            400,
        )
        self.assertEqual(
            (
                await self.client.get(
                    "/v1/toolsets",
                    headers={"Authorization": "Bearer 한글", "X-Mori-User-ID": self.a},
                )
            ).status,
            401,
        )
        self.assertEqual(
            (
                await self.client.get(
                    "/v1/toolsets",
                    headers=[
                        ("Authorization", "Bearer " + self.config.key),
                        ("Authorization", "Bearer " + self.config.key),
                        ("X-Mori-User-ID", self.a),
                    ],
                )
            ).status,
            401,
        )
        self.assertEqual(
            (
                await self.client.get(
                    "/v1/toolsets",
                    headers=[
                        ("Authorization", "Bearer " + self.config.key),
                        ("X-Mori-User-ID", self.a),
                        ("X-Mori-User-ID", self.b),
                    ],
                )
            ).status,
            400,
        )
        self.assertEqual(len(self.launched), 0)

    async def test_profile_overrides_and_shared_session_headers_never_forward(self):
        for overrides in (
            {"profile": self.b},
            {"previous_response_id": "other"},
            {"store": True},
            {"tools": ["terminal"]},
            {"model": "unsafe"},
            {"stream": False},
            {"conversation_history": [{"role": "tool", "content": "other"}]},
        ):
            response = await self.send(self.a, "hi", **overrides)
            self.assertEqual(response.status, 422)
        headers = self.headers(self.a)
        headers["X-Hermes-Session-Id"] = "foreign-session"
        response = await self.client.get("/v1/toolsets", headers=headers)
        self.assertEqual(response.status, 200)
        await response.read()
        self.assertEqual(len(self.launched), 1)

    async def test_stream_holds_profile_lease_and_strips_upstream_headers(self):
        self.config.max_processes = 1
        response = await self.send(self.a, "stream")
        await asyncio.wait_for(self.stream_started.wait(), 2)
        self.assertNotIn("X-Hermes-Session-Id", response.headers)
        self.assertIn(b'"start": true', await response.content.readany())
        child = self.pool.children[self.a]
        self.assertEqual(child.active, 1)
        queued = asyncio.create_task(self.send(self.a, "queued"))
        for _ in range(100):
            if child.active == 2:
                break
            await asyncio.sleep(0.01)
        self.assertEqual(child.active, 2)
        self.assertNotIn("queued", self.inputs)
        child.last_used -= 20
        await self.pool.reap()
        self.assertIn(self.a, self.pool.children)
        other = await self.send(self.b, "cannot-evict")
        self.assertEqual(other.status, 503)
        self.assertEqual((await other.json())["error"]["code"], "SHARED_CAPACITY")
        self.stream_gate.set()
        self.assertIn('"end": true', await response.text())
        queued_response = await asyncio.wait_for(queued, 2)
        self.assertEqual(queued_response.status, 200)
        await queued_response.read()
        for _ in range(20):
            if child.active == 0:
                break
            await asyncio.sleep(0.01)
        self.assertEqual(child.active, 0)

    async def test_failed_startup_is_removed_and_next_request_retries(self):
        self.toolsets = {"data": [{"name": "terminal", "enabled": True, "tools": ["terminal"]}]}
        response = await self.send(self.a, "unsafe")
        self.assertEqual(response.status, 503)
        self.assertEqual(self.pool.children, {})
        self.toolsets = TOOLSETS
        response = await self.send(self.a, "safe")
        self.assertEqual(response.status, 200)
        await response.read()
        self.assertEqual(len(self.launched), 2)

    async def test_disconnected_stream_stops_child_before_profile_reuse(self):
        response = await self.send(self.a, "stream")
        await asyncio.wait_for(self.stream_started.wait(), 2)
        child = self.pool.children[self.a]
        response.close()
        for _ in range(100):
            if self.a not in self.pool.children:
                break
            await asyncio.sleep(0.01)
        self.assertNotIn(self.a, self.pool.children)
        self.assertIsNotNone(child.process.returncode)
        self.stream_gate.set()
        again = await self.send(self.a, "retry")
        self.assertEqual(again.status, 200)
        await again.read()
        self.assertNotEqual(self.pool.children[self.a].key, child.key)

    async def test_cancelled_queued_request_does_not_stop_active_stream(self):
        response = await self.send(self.a, "stream")
        await asyncio.wait_for(self.stream_started.wait(), 2)
        child = self.pool.children[self.a]
        queued = asyncio.create_task(self.send(self.a, "queued"))
        for _ in range(100):
            if child.active == 2:
                break
            await asyncio.sleep(0.01)
        self.assertEqual(child.active, 2)
        queued.cancel()
        await asyncio.gather(queued, return_exceptions=True)
        for _ in range(100):
            if child.active == 1:
                break
            await asyncio.sleep(0.01)
        self.assertIs(self.pool.children.get(self.a), child)
        self.assertIsNone(child.process.returncode)
        self.assertNotIn("queued", self.inputs)
        self.stream_gate.set()
        self.assertIn('"end": true', await response.text())

    async def test_disconnected_stream_blocks_queue_before_pool_cleanup(self):
        response = await self.send(self.a, "stream")
        await asyncio.wait_for(self.stream_started.wait(), 2)
        child = self.pool.children[self.a]
        queued = asyncio.create_task(self.send(self.a, "queued"))
        for _ in range(100):
            if child.active == 2:
                break
            await asyncio.sleep(0.01)
        self.assertEqual(child.active, 2)
        async with self.pool.lock:
            response.close()
            for _ in range(100):
                if child.invalid or "queued" in self.inputs:
                    break
                await asyncio.sleep(0.01)
            self.assertNotIn("queued", self.inputs)
            self.assertTrue(child.invalid)
        rejected = await asyncio.wait_for(queued, 2)
        self.assertEqual(rejected.status, 503)

    async def test_inventory_changes_and_malformed_rows_fail_closed(self):
        response = await self.send(self.a, "safe")
        await response.read()
        self.toolsets = {"data": [None]}
        response = await self.client.get("/v1/toolsets", headers=self.headers(self.a))
        self.assertEqual(response.status, 503)
        self.assertEqual(self.pool.children, {})

    async def test_capacity_and_periodic_profile_quota(self):
        self.config.max_profiles = 1
        response = await self.send(self.a, "safe")
        await response.read()
        response = await self.send(self.b, "over-profile-limit")
        self.assertEqual(response.status, 503)
        self.assertEqual((await response.json())["error"]["code"], "PROFILE_CAPACITY")
        child = self.pool.children[self.a]
        self.config.profile_max_bytes = 5
        await self.pool.reap()
        self.assertEqual(self.pool.children, {})
        self.assertIsNotNone(child.process.returncode)
        self.assertTrue((child.home / "memory.txt").exists())

    async def test_profile_env_and_escape_symlinks_rejected(self):
        home = self.config.root / self.a
        home.mkdir()
        (home / ".env").write_text("API_SERVER_KEY=stale-key")
        response = await self.send(self.a, "unsafe")
        self.assertEqual(response.status, 503)
        (home / ".env").unlink()
        (home / ".op.env").write_text("API_SERVER_KEY=op://unexpected")
        response = await self.send(self.a, "unsafe")
        self.assertEqual(response.status, 503)
        (home / ".op.env").unlink()
        (home / "tmp").symlink_to(self.config.root)
        response = await self.send(self.a, "unsafe")
        self.assertEqual(response.status, 503)

    async def test_actual_child_process_receives_isolated_home_and_cli_arguments(self):
        script = Path(self.temp.name) / "fake-hermes"
        script.write_text(
            "#!"
            + sys.executable
            + "\n"
            + r"""
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
assert sys.argv[1:] == ['gateway', 'run']
assert os.environ['HOME'] == os.environ['HERMES_HOME'] == os.getcwd()
Path('child-state.json').write_text(json.dumps({key: os.environ.get(key) for key in
    ['HOME', 'HERMES_HOME', 'API_SERVER_KEY', 'MORI_SHARED_GATEWAY_KEY']}))
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        assert self.headers['Authorization'] == 'Bearer ' + os.environ['API_SERVER_KEY']
        data = json.dumps({'data': [{'name': 'web', 'enabled': True, 'configured': True,
                                  'tools': ['web_search', 'web_extract']}]}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *args): pass
HTTPServer(('127.0.0.1', int(os.environ['API_SERVER_PORT'])), Handler).serve_forever()
"""
        )
        script.chmod(0o700)
        self.config.child_command = str(script)
        self.config.startup_seconds = 5
        pool = gateway.ProcessPool(self.config)
        try:
            a = await pool.acquire(self.a)
            b = await pool.acquire(self.b)
            self.assertNotEqual(a.process.pid, b.process.pid)
            for child in (a, b):
                state = json.loads((child.home / "child-state.json").read_text())
                self.assertEqual(state["HOME"], str(child.home))
                self.assertEqual(state["HERMES_HOME"], str(child.home))
                self.assertEqual(state["API_SERVER_KEY"], child.key)
                self.assertIsNone(state["MORI_SHARED_GATEWAY_KEY"])
                await pool.release(child)
        finally:
            await pool.close()

    async def test_stop_cleans_helpers_after_parent_exit(self):
        script = Path(self.temp.name) / "fake-hermes-with-helper"
        helper = """
import signal, socket
from pathlib import Path
signal.signal(signal.SIGINT, signal.SIG_IGN)
with socket.socket() as server:
    server.bind(('127.0.0.1', 0))
    server.listen()
    Path('helper-port').write_text(str(server.getsockname()[1]))
    while True:
        connection, _ = server.accept()
        connection.close()
"""
        script.write_text(
            "#!" + sys.executable + "\n"
            "import subprocess, sys, time\n"
            f"subprocess.Popen([sys.executable, '-c', {helper!r}])\n"
            "while True: time.sleep(1)\n"
        )
        script.chmod(0o700)
        self.config.child_command = str(script)
        for already_exited in (False, True):
            with self.subTest(already_exited=already_exited):
                user = str(uuid4())
                home = gateway.check_profile(self.config, user)
                process = await self.pool.launch(home, 12345, "child-key")
                child = gateway.Child(user, home, 12345, "child-key", process)
                try:
                    for _ in range(100):
                        if (home / "helper-port").exists():
                            break
                        await asyncio.sleep(0.01)
                    port = int((home / "helper-port").read_text())
                    if already_exited:
                        process.send_signal(signal.SIGINT)
                        await asyncio.wait_for(process.wait(), 2)
                    await self.pool.stop(child)
                    connected = True
                    for _ in range(100):
                        with socket.socket() as client:
                            client.settimeout(0.1)
                            connected = client.connect_ex(("127.0.0.1", port)) == 0
                        if not connected:
                            break
                        await asyncio.sleep(0.01)
                    self.assertFalse(connected, "Profile helper survived parent cleanup")
                finally:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    await process.wait()

    def test_entrypoint_preserves_upstream_setup_and_image_checks_dependencies(self):
        entrypoint = ROOT / "backend/hermes/entrypoint.sh"
        subprocess.run(["sh", "-n", str(entrypoint)], check=True)
        source = entrypoint.read_text()
        self.assertLess(
            source.index("/opt/hermes/docker/stage2-hook.sh"),
            source.index("MORI_SHARED_GATEWAY_ENABLED"),
        )
        self.assertIn(
            "exec /opt/hermes/docker/main-wrapper.sh python /opt/mori/shared_gateway.py", source
        )
        self.assertIn('exec /opt/hermes/docker/main-wrapper.sh "$@"', source)
        dockerfile = (ROOT / "backend/hermes/Dockerfile").read_text()
        self.assertIn("COPY shared_gateway.py /opt/mori/shared_gateway.py", dockerfile)
        self.assertIn("import aiohttp, yaml", dockerfile)

    def test_global_fallback_configuration_cannot_override_child_identity(self):
        project = Path(self.temp.name) / "checkout"
        managed = Path(self.temp.name) / "managed"
        project.mkdir()
        managed.mkdir()
        (managed / "image-provenance.json").write_text("{}")
        gateway.validate_base_environment(project, managed)
        for path in (project / ".env", managed / ".env", managed / "config.yaml"):
            path.write_text("unsafe")
            with self.assertRaisesRegex(ValueError, "global Hermes"):
                gateway.validate_base_environment(project, managed)
            path.unlink()

    def test_shared_manifest_has_one_pod_and_internal_trusted_ingress(self):
        objects = list(yaml.safe_load_all((ROOT / "infra/k3s/shared-gateway.yaml").read_text()))
        resources = {item["kind"]: item for item in objects}
        deployment = resources["Deployment"]["spec"]
        self.assertEqual(deployment["replicas"], 1)
        self.assertEqual(deployment["strategy"]["type"], "Recreate")
        pod = deployment["template"]["spec"]
        self.assertFalse(pod["automountServiceAccountToken"])
        self.assertEqual(resources["Service"]["spec"]["type"], "ClusterIP")
        rule = resources["NetworkPolicy"]["spec"]["ingress"][0]
        self.assertEqual(rule["ports"], [{"protocol": "TCP", "port": 8642}])
        self.assertEqual(
            {entry["podSelector"]["matchLabels"]["app"] for entry in rule["from"]},
            {"mori-api", "mori-worker"},
        )

    async def test_active_profiles_not_evicted_and_idle_lru_reused_safely(self):
        a = await self.pool.acquire(self.a)
        b = await self.pool.acquire(self.b)
        with self.assertRaisesRegex(gateway.GatewayError, "SHARED_CAPACITY"):
            await self.pool.acquire(str(uuid4()))
        await self.pool.release(a)
        c = await self.pool.acquire(str(uuid4()))
        self.assertIsNotNone(a.process.returncode)
        self.assertIsNone(b.process.returncode)
        self.assertNotEqual(c.home, a.home)
        await self.pool.release(b)
        await self.pool.release(c)
        b.last_used -= 11
        c.last_used -= 11
        await self.pool.reap()
        self.assertEqual(self.pool.children, {})

    async def test_root_symlinks_and_storage_quota_rejected(self):
        home = self.config.root / self.a
        home.symlink_to(self.config.root / "outside")
        with self.assertRaisesRegex(gateway.GatewayError, "PROFILE_INVALID"):
            await self.pool.acquire(self.a)
        home.unlink()
        home.mkdir()
        self.config.profile_max_bytes = 5
        (home / "memory.txt").write_text("too large")
        with self.assertRaisesRegex(gateway.GatewayError, "PROFILE_QUOTA"):
            await self.pool.acquire(self.a)

    async def test_environment_allowlist_does_not_inherit_gateway_or_other_channels(self):
        home = self.config.root / self.a
        home.mkdir()
        template = gateway.profile_config(self.config, home, 12345)
        with patch.dict(
            os.environ,
            {
                "LLAMA_API_KEY": "provider",
                "TELEGRAM_BOT_TOKEN": "other",
                "MORI_SHARED_GATEWAY_KEY": "parent-secret",
                "HERMES_HOME": "wrong",
                "PATH": "/opt/data/.local/bin:/untrusted",
            },
        ):
            env = gateway.build_environment(self.config, home, 12345, "child-secret", template)
        self.assertEqual(env["LLAMA_API_KEY"], "provider")
        self.assertNotIn("TELEGRAM_BOT_TOKEN", env)
        self.assertNotIn("MORI_SHARED_GATEWAY_KEY", env)
        self.assertNotIn("/opt/data", env["PATH"])
        self.assertNotIn("/untrusted", env["PATH"])
        self.assertEqual(env["HERMES_HOME"], str(home))


if __name__ == "__main__":
    unittest.main()
