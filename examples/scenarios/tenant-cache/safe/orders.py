from storage import OrderStore


class OrderService:
    def __init__(self, store: OrderStore):
        self.store = store
        self.cache = {}

    def get(self, tenant_id, order_id):
        tenant_cache = self.cache.setdefault(tenant_id, {})
        if order_id not in tenant_cache:
            tenant_cache[order_id] = self.store.get(tenant_id, order_id)
        return tenant_cache[order_id]
