"""Exercise the real durable queue while replacing only external Hermes HTTP."""

import asyncio
from contextlib import contextmanager
from threading import Event, Thread

from mori.chat.jobs import run_chat_once
from mori.chat.router import get_chat_transport


@contextmanager
def running_chat_worker(client):
    settings = client.app.state.settings
    settings.chat_worker_enabled = True
    settings.chat_job_max_attempts = 1
    errors, stopped = [], Event()

    def worker():
        async def loop():
            while not stopped.is_set():
                try:
                    override = client.app.dependency_overrides.get(get_chat_transport)
                    if override:
                        await run_chat_once(
                            client.app.state.session_factory, settings, transport=override()
                        )
                except Exception as exc:
                    errors.append(exc)
                    return
                await asyncio.sleep(0.01)

        asyncio.run(loop())

    thread = Thread(target=worker, daemon=True)
    thread.start()
    try:
        yield
    finally:
        stopped.set()
        thread.join(timeout=5)
        assert not thread.is_alive(), "Chat test worker did not stop"
        assert not errors, errors
