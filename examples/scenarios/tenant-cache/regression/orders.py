from storage import OrderStore


class OrderService:
    def __init__(self, store: OrderStore):
        self.store = store
        self.cache = {}

    def get(self, tenant_id, order_id):
        key = order_id
        if key not in self.cache:
            self.cache[key] = self.store.get(tenant_id, order_id)
        return self.cache[key]
