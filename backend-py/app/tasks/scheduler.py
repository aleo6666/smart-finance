"""APScheduler 定时任务：异常提醒 / 月度报告 / 自动备份。

启动时通过 ``mount_scheduler`` 挂载；``settings.schedule_enabled`` 为 False
（默认）时不启动，测试环境保持关闭。
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import date

from fastapi import FastAPI
from sqlalchemy import select

from app.core.config import Settings
from app.core.database import AsyncSessionLocal
from app.models import Reminder, User
from app.services.analysis_service import get_anomaly_analysis
from app.services.backup import run_backup
from app.services.report_generator import generate_monthly_report

logger = logging.getLogger(__name__)


async def _all_user_ids() -> list[int]:
    async with AsyncSessionLocal() as session:
        return list((await session.scalars(select(User.id))).all())


async def run_anomaly_detection(settings: Settings) -> int:
    """每日异常消费检测：跑全用户，有异常则生成提醒记录。"""
    created = 0
    for user_id in await _all_user_ids():
        async with AsyncSessionLocal() as session:
            try:
                analysis = await get_anomaly_analysis(
                    session,
                    user_id,
                    standard_deviations=settings.anomaly_standard_deviations,
                )
            except Exception:
                logger.warning("异常检测失败 user=%s", user_id, exc_info=True)
                continue
            anomalies = analysis.get("anomalies")
            if not anomalies:
                continue
            session.add(
                Reminder(
                    user_id=user_id,
                    type="anomaly",
                    title="异常消费提醒",
                    message=json.dumps(
                        {"count": len(anomalies), "anomalies": anomalies},
                        ensure_ascii=False,
                        default=str,
                    ),
                    status="pending",
                )
            )
            try:
                await session.commit()
                created += 1
            except Exception:
                await session.rollback()
                logger.warning("异常提醒写入失败 user=%s", user_id, exc_info=True)
    return created


def _previous_month(today: date) -> tuple[int, int]:
    if today.month == 1:
        return today.year - 1, 12
    return today.year, today.month - 1


async def run_monthly_reports(settings: Settings) -> int:
    """每月 1 日生成上月月度报告（全用户）。"""
    year, month = _previous_month(date.today())
    created = 0
    for user_id in await _all_user_ids():
        async with AsyncSessionLocal() as session:
            try:
                await generate_monthly_report(session, user_id, year, month)
                created += 1
            except Exception:
                await session.rollback()
                logger.warning("月度报告生成失败 user=%s", user_id, exc_info=True)
    return created


async def run_backup_job(settings: Settings) -> list:
    """每日自动备份（阻塞子进程放到线程池执行）。"""
    return await asyncio.to_thread(run_backup, "full", settings)


async def run_exchange_fetch(settings: Settings) -> bool:
    """每小时刷新汇率快照（失败静默，下次重试）。"""
    from app.services.exchange_rate import fetch_rates

    async with AsyncSessionLocal() as session:
        return await fetch_rates(session)


def create_scheduler(settings: Settings):
    from apscheduler.schedulers.asyncio import AsyncIOScheduler

    scheduler = AsyncIOScheduler(timezone="Asia/Shanghai")
    scheduler.add_job(
        run_anomaly_detection,
        "cron",
        args=[settings],
        hour=2,
        minute=0,
        id="anomaly_detection",
        replace_existing=True,
    )
    scheduler.add_job(
        run_monthly_reports,
        "cron",
        args=[settings],
        day=1,
        hour=3,
        minute=0,
        id="monthly_report",
        replace_existing=True,
    )
    scheduler.add_job(
        run_backup_job,
        "cron",
        args=[settings],
        hour=4,
        minute=0,
        id="backup",
        replace_existing=True,
    )
    scheduler.add_job(
        run_exchange_fetch,
        "interval",
        args=[settings],
        hours=1,
        id="exchange_rates",
        replace_existing=True,
    )
    return scheduler


def mount_scheduler(application: FastAPI, settings: Settings) -> None:
    if not settings.schedule_enabled:
        return
    scheduler = create_scheduler(settings)

    @application.on_event("startup")
    async def _start_scheduler() -> None:
        scheduler.start()
        logger.info("Scheduler started (anomaly/monthly-report/backup)")

    @application.on_event("shutdown")
    async def _stop_scheduler() -> None:
        scheduler.shutdown(wait=False)

    application.state.scheduler = scheduler
