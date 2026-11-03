"""Dedicated provisioner: python -m mori.runtimes.worker [--once]."""

import argparse
import asyncio
import logging
import signal
import time
from pathlib import Path

from mori.config import Settings
from mori.database import build_engine, build_session_factory
from mori.operations.service import heartbeat
from mori.runtimes.service import process_once

logger = logging.getLogger(__name__)


async def run(factory, settings, once=False):
    if not settings.runtime_provisioning_enabled:
        raise ValueError("Enable MORI_RUNTIME_PROVISIONING_ENABLED for the provisioner")
    if once:
        return await process_once(factory, settings)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    health = {"success": False, "error_code": None}
    pulse = asyncio.create_task(publish_heartbeat(factory, stop, health))
    try:
        while not stop.is_set():
            try:
                # Drain a bounded batch so newly approved users do not wait one poll per user.
                for _ in range(50):
                    if stop.is_set() or not await process_once(factory, settings):
                        break
                health.update(success=True, error_code=None)
            except Exception as exc:
                health.update(success=False, error_code="RUNTIME_WORKER_FAILED")
                logger.error("Runtime reconciliation cycle failed (%s)", type(exc).__name__)
            try:
                await asyncio.wait_for(stop.wait(), timeout=settings.runtime_poll_seconds)
            except TimeoutError:
                pass
    finally:
        stop.set()
        await pulse


async def publish_heartbeat(factory, stop, health):
    """Publish independently of a long cluster request or reconciliation batch."""
    path = Path("/tmp/mori-runtime-worker-heartbeat")
    while not stop.is_set():
        try:
            await asyncio.to_thread(heartbeat, factory, "provisioning", **health)
            path.write_text(str(time.time()))
        except Exception:
            logger.error("Runtime worker heartbeat unavailable")
        try:
            await asyncio.wait_for(stop.wait(), timeout=20)
        except TimeoutError:
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    settings = Settings()
    engine = build_engine(settings)
    try:
        asyncio.run(run(build_session_factory(engine), settings, args.once))
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
