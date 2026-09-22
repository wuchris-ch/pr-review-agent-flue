class OrderRepository:
    def __init__(self, connection):
        self.connection = connection

    def page(self, cursor, limit):
        return self.connection.execute(
            "SELECT id FROM orders WHERE id > ? ORDER BY id LIMIT ?",
            (cursor, limit),
        ).fetchall()
