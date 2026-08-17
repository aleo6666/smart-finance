import pytest
from sqlalchemy import Float, Numeric

from app.models import Budget, Goal, Ledger, Transaction, User


MODEL_COLUMNS = [
    (
        User,
        "users",
        {
            "id",
            "email",
            "password_hash",
            "nickname",
            "created_at",
            "updated_at",
        },
    ),
    (
        Ledger,
        "ledgers",
        {
            "id",
            "user_id",
            "name",
            "icon",
            "color",
            "base_currency",
            "created_at",
        },
    ),
    (
        Transaction,
        "transactions",
        {
            "id",
            "user_id",
            "ledger_id",
            "type",
            "category",
            "amount",
            "currency",
            "note",
            "occurred_at",
            "created_at",
        },
    ),
    (
        Budget,
        "budgets",
        {
            "id",
            "user_id",
            "ledger_id",
            "category",
            "amount",
            "period",
            "period_start",
            "period_end",
            "created_at",
        },
    ),
    (
        Goal,
        "goals",
        {
            "id",
            "user_id",
            "name",
            "target_amount",
            "current_amount",
            "target_date",
            "created_at",
        },
    ),
]


@pytest.mark.parametrize(("model", "table_name", "columns"), MODEL_COLUMNS)
def test_business_model_has_expected_table_and_columns(
    model: type, table_name: str, columns: set[str]
) -> None:
    assert model.__tablename__ == table_name
    assert set(model.__table__.columns.keys()) == columns


def test_money_columns_use_numeric_12_2_and_never_float() -> None:
    money_columns = (
        Transaction.__table__.c.amount,
        Budget.__table__.c.amount,
        Goal.__table__.c.target_amount,
        Goal.__table__.c.current_amount,
    )

    for column in money_columns:
        assert isinstance(column.type, Numeric)
        assert not isinstance(column.type, Float)
        assert column.type.precision == 12
        assert column.type.scale == 2


@pytest.mark.parametrize("model", [Ledger, Transaction, Budget, Goal])
def test_user_scoped_model_indexes_user_id(model: type) -> None:
    indexed_column_sets = {
        tuple(column.name for column in index.columns)
        for index in model.__table__.indexes
    }

    assert ("user_id",) in indexed_column_sets
