from decimal import Decimal
from typing import Any


def decimal_strings(value: Any) -> Any:
    """Serialize Decimal recursively without converting through binary float."""
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, dict):
        return {key: decimal_strings(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [decimal_strings(item) for item in value]
    return value
