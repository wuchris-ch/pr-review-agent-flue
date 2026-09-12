import sqlite3


def find_product(connection: sqlite3.Connection, product_id: str):
    """Look up a catalog product by its request-supplied identifier."""
    return connection.execute(
        "SELECT id, name FROM products WHERE id = ?", (product_id,)
    ).fetchone()
