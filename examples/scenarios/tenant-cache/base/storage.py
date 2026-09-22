class OrderStore:
    """The tenant is part of every primary key, including external order IDs."""
    def __init__(self, orders):
        self.orders = {(row["tenant"], row["id"]): dict(row) for row in orders}

    def get(self, tenant_id, order_id):
        return self.orders[(tenant_id, order_id)]
