import sqlite3


def find_order(connection: sqlite3.Connection, order_id: str):
    """Look up an order by its request-supplied identifier."""
    return connection.execute(
        f"SELECT id, total FROM orders WHERE id = '{order_id}'"
    ).fetchone()
