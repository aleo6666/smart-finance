import pytest
from sqlalchemy import Enum, Float, Numeric

from app.models import (
    Asset,
    Budget,
    Goal,
    Ledger,
    Liability,
    Report,
    Transaction,
    User,
    UserProfile,
)


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
            "receipt_path",
            "income_source",
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
    (
        Asset,
        "assets",
        {
            "id",
            "user_id",
            "type",
            "name",
            "amount",
            "currency",
            "acquired_date",
            "notes",
            "created_at",
        },
    ),
    (
        Liability,
        "liabilities",
        {
            "id",
            "user_id",
            "type",
            "name",
            "amount",
            "interest_rate",
            "monthly_payment",
            "due_date",
            "created_at",
        },
    ),
    (
        UserProfile,
        "user_profiles",
        {
            "id",
            "user_id",
            "age",
            "occupation",
            "income_range",
            "marital_status",
            "children",
            "dependents",
            "risk_preference",
            "financial_goals",
            "updated_at",
        },
    ),
    (
        Report,
        "reports",
        {"id", "user_id", "report_type", "period", "content", "created_at"},
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
        Asset.__table__.c.amount,
        Liability.__table__.c.amount,
        Liability.__table__.c.monthly_payment,
    )

    for column in money_columns:
        assert isinstance(column.type, Numeric)
        assert not isinstance(column.type, Float)
        assert column.type.precision == 12
        assert column.type.scale == 2

    interest_rate = Liability.__table__.c.interest_rate
    assert isinstance(interest_rate.type, Numeric)
    assert not isinstance(interest_rate.type, Float)
    assert interest_rate.type.precision == 5
    assert interest_rate.type.scale == 4


@pytest.mark.parametrize(
    "model", [Ledger, Transaction, Budget, Goal, Asset, Liability, UserProfile, Report]
)
def test_user_scoped_model_indexes_user_id(model: type) -> None:
    indexed_column_sets = {
        tuple(column.name for column in index.columns)
        for index in model.__table__.indexes
    }

    assert ("user_id",) in indexed_column_sets


def test_user_profile_user_id_is_unique() -> None:
    assert UserProfile.__table__.c.user_id.unique is True


@pytest.mark.parametrize(
    ("column", "values"),
    [
        (
            Asset.__table__.c.type,
            {"cash", "bank_deposit", "investment", "property", "vehicle", "other"},
        ),
        (
            Liability.__table__.c.type,
            {"credit_card", "loan", "mortgage", "other"},
        ),
        (
            UserProfile.__table__.c.risk_preference,
            {"保守", "稳健", "进取", "激进"},
        ),
        (
            Transaction.__table__.c.income_source,
            {"salary", "bonus", "part_time", "investment", "other"},
        ),
    ],
)
def test_financial_model_enums_have_expected_values(column, values: set[str]) -> None:
    assert isinstance(column.type, Enum)
    assert set(column.type.enums) == values
