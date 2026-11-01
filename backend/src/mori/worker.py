"""Explicit worker process; long AI jobs do not delay reminder delivery."""

import asyncio
import logging

from mori.automation.scheduler import run_once
from mori.automation.scheduler import run_worker as run_automation
from mori.notifications.service import deliver_due

logger = logging.getLogger(__name__)


async def run_cycle(factory, settings):
    if not settings.automation_enabled and not settings.push_enabled:
        raise ValueError("Enable MORI_AUTOMATION_ENABLED or MORI_PUSH_ENABLED")
    automation, notifications = await asyncio.gather(
        run_once(factory, settings),
        asyncio.to_thread(deliver_due, factory, settings),
    )
    return {"automation_processed": automation, "notifications": notifications}


async def run_notifications(factory, settings, stop):
    while not stop.is_set():
        try:
            await asyncio.to_thread(deliver_due, factory, settings)
        except Exception:
            logger.error("Notification worker cycle failed")
        try:
            await asyncio.wait_for(stop.wait(), timeout=settings.automation_poll_seconds)
        except TimeoutError:
            pass


async def run_worker(factory, settings):
    if not settings.automation_enabled and not settings.push_enabled:
        raise ValueError("Enable MORI_AUTOMATION_ENABLED or MORI_PUSH_ENABLED")
    stop = asyncio.Event()
    tasks = []
    if settings.automation_enabled:
        tasks.append(run_automation(factory, settings, stop=stop))
    if settings.push_enabled:
        tasks.append(run_notifications(factory, settings, stop))
    await asyncio.gather(*tasks)
