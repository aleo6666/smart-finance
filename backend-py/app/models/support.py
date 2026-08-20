"""对齐旧 Node 后端三模块的表模型：汇率看板 / 用户反馈 / 账单导入批次。

- ExchangeRate：汇率快照（基准 CNY，rate 表示 1 单位外币 = X 人民币，倒挂计算）
- Feedback：用户反馈（含截图路径、自动分级 P0/P1/P2、后台回复）
- ImportBatch / ImportRecord：账单导入批次与明细（preview → imported → rolled_back）

货币列统一 Numeric 保留小数精度；枚举使用 native_enum=False 以便 MySQL
存储为可移植的 VARCHAR 值；时间列 server_default=func.now()。
"""

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    DateTime,
    Enum,
    ForeignKey,
    Numeric,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class ExchangeRate(Base):
    __tablename__ = "exchange_rates"

    id: Mapped[int] = mapped_column(primary_key=True)
    base: Mapped[str] = mapped_column(
        String(8), default="CNY", server_default="CNY"
    )
    currency: Mapped[str] = mapped_column(String(16), index=True)
    rate: Mapped[Decimal] = mapped_column(Numeric(14, 8))
    fetched_at: Mapped[datetime] = mapped_column(DateTime(), index=True)


class Feedback(Base):
    __tablename__ = "feedback"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    type: Mapped[str] = mapped_column(
        String(32), default="suggestion", server_default="suggestion"
    )
    content: Mapped[str] = mapped_column(Text())
    image_path: Mapped[str | None] = mapped_column(String(512))
    priority: Mapped[str] = mapped_column(
        String(8), default="P2", server_default="P2"
    )
    status: Mapped[str] = mapped_column(
        String(32), default="pending", server_default="pending"
    )
    admin_reply: Mapped[str | None] = mapped_column(Text())
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(), server_default=func.now(), onupdate=func.now()
    )


class ImportBatch(Base):
    __tablename__ = "import_batches"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    ledger_id: Mapped[int | None] = mapped_column(
        ForeignKey("ledgers.id", ondelete="CASCADE")
    )
    source_type: Mapped[str] = mapped_column(String(32))  # wechat/alipay/generic/excel
    file_name: Mapped[str] = mapped_column(
        String(255), default="", server_default=""
    )
    total_count: Mapped[int] = mapped_column(default=0, server_default="0")
    valid_count: Mapped[int] = mapped_column(default=0, server_default="0")
    duplicate_count: Mapped[int] = mapped_column(default=0, server_default="0")
    error_count: Mapped[int] = mapped_column(default=0, server_default="0")
    imported_count: Mapped[int] = mapped_column(default=0, server_default="0")
    status: Mapped[str] = mapped_column(
        Enum(
            "preview",
            "imported",
            "rolled_back",
            name="import_batch_status",
            native_enum=False,
            create_constraint=True,
        ),
        default="preview",
        server_default="preview",
    )
    preview_data: Mapped[str | None] = mapped_column(Text())  # JSON：前 200 条预览
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), server_default=func.now()
    )
    imported_at: Mapped[datetime | None] = mapped_column(DateTime())
    rolled_back_at: Mapped[datetime | None] = mapped_column(DateTime())


class ImportRecord(Base):
    __tablename__ = "import_records"

    id: Mapped[int] = mapped_column(primary_key=True)
    batch_id: Mapped[int] = mapped_column(
        ForeignKey("import_batches.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    original_row: Mapped[str | None] = mapped_column(Text())  # JSON 原始行
    mapped_type: Mapped[str] = mapped_column(String(16))
    mapped_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    mapped_category: Mapped[str] = mapped_column(String(64))
    mapped_date: Mapped[str] = mapped_column(String(16))  # YYYY-MM-DD
    mapped_description: Mapped[str | None] = mapped_column(Text())
    mapped_merchant: Mapped[str | None] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(
        String(16), default="pending", server_default="pending"
    )
    is_duplicate: Mapped[bool] = mapped_column(default=False, server_default="0")
    duplicate_similarity: Mapped[Decimal] = mapped_column(
        Numeric(6, 4), default=Decimal("0"), server_default="0"
    )
    duplicate_of_record_id: Mapped[int | None] = mapped_column()
    selected: Mapped[bool] = mapped_column(default=True, server_default="1")
    record_id: Mapped[int | None] = mapped_column()  # 确认后写入的 Transaction.id
    imported_at: Mapped[datetime | None] = mapped_column(DateTime())
    created_at: Mapped[datetime] = mapped_column(
        DateTime(), server_default=func.now()
    )
