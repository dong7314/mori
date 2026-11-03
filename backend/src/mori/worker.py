"""Independent durable queues; a slow AI job never blocks reminders or billing."""

import asyncio
import logging
import signal

from mori.artifacts.service import run_document_once
from mori.automation.prewarm import prewarm_once
from mori.automation.scheduler import run_once
from mori.billing.service import run_billing_once
from mori.chat.jobs import run_chat_once
from mori.notifications.service import deliver_due
from mori.operations.service import heartbeat

logger = logging.getLogger(__name__)


def enabled(settings):
    return any(
        (
            settings.automation_enabled,
            settings.push_enabled,
            settings.chat_worker_enabled,
            settings.documents_enabled,
            settings.billing_enabled,
        )
    )


async def run_cycle(factory, settings):
    if not enabled(settings):
        raise ValueError(
            "Enable MORI_AUTOMATION_ENABLED, MORI_PUSH_ENABLED, "
            "MORI_CHAT_WORKER_ENABLED, MORI_DOCUMENTS_ENABLED or MORI_BILLING_ENABLED"
        )
    names = ["automation_processed", "notifications"]
    tasks = [run_once(factory, settings), asyncio.to_thread(deliver_due, factory, settings)]
    if settings.chat_worker_enabled:
        names.append("chat_processed")
        tasks.append(run_chat_once(factory, settings))
    if settings.documents_enabled:
        names.append("documents_processed")
        tasks.append(run_document_once(factory, settings))
    if settings.billing_enabled:
        names.append("billing_processed")
        tasks.append(run_billing_once(factory, settings))
    if factory is not None and settings.automation_enabled:
        names.append("prewarmed")
        tasks.append(prewarm_once(factory, settings))
    return dict(zip(names, await asyncio.gather(*tasks), strict=True))


async def component_loop(factory, settings, stop, name, operation, poll):
    state = {"error": None}

    async def pulse():
        while not stop.is_set():
            try:
                await asyncio.to_thread(heartbeat, factory, name, error_code=state["error"])
            except Exception:
                logger.error("Worker heartbeat unavailable (%s)", name)
            try:
                await asyncio.wait_for(stop.wait(), timeout=20)
            except TimeoutError:
                pass

    ticker = asyncio.create_task(pulse())
    try:
        while not stop.is_set():
            processed = False
            try:
                processed = await operation()
                state["error"] = None
                await asyncio.to_thread(heartbeat, factory, name, success=True)
            except Exception:
                state["error"] = "WORKER_CYCLE_FAILED"
                logger.error("Worker cycle failed (%s)", name)
            # Drain busy queues without a full poll delay; keep failures rate limited.
            useful = (
                processed
                if not isinstance(processed, dict)
                else any(processed.get(key, 0) for key in ("sent", "queued", "processed"))
            )
            delay = 0.05 if useful and not state["error"] else poll
            try:
                await asyncio.wait_for(stop.wait(), timeout=delay)
            except TimeoutError:
                pass
    finally:
        ticker.cancel()
        await asyncio.gather(ticker, return_exceptions=True)


async def run_worker(factory, settings):
    if not enabled(settings):
        raise ValueError("Enable MORI_AUTOMATION_ENABLED or another worker component")
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError):
            pass
    specs = []
    if settings.automation_enabled:
        specs.extend(
            [
                (
                    "automation",
                    lambda: run_once(factory, settings),
                    settings.automation_poll_seconds,
                ),
                (
                    "prewarm",
                    lambda: prewarm_once(factory, settings),
                    settings.automation_poll_seconds,
                ),
            ]
        )
    if settings.push_enabled:
        specs.append(
            (
                "push",
                lambda: asyncio.to_thread(deliver_due, factory, settings),
                settings.automation_poll_seconds,
            )
        )
    if settings.chat_worker_enabled:
        specs.append(("chat", lambda: run_chat_once(factory, settings), settings.chat_poll_seconds))
    if settings.documents_enabled:
        specs.append(("documents", lambda: run_document_once(factory, settings), 2))
    if settings.billing_enabled:
        specs.append(("billing", lambda: run_billing_once(factory, settings), 15))
    await asyncio.gather(*(component_loop(factory, settings, stop, *spec) for spec in specs))
