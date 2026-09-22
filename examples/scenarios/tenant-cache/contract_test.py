import unittest
from orders import OrderService
from storage import OrderStore

class IsolationContract(unittest.TestCase):
    def test_warm_cache_keeps_tenants_isolated(self):
        service = OrderService(OrderStore([
            {"tenant": "north", "id": "order-17", "amount": 1200},
            {"tenant": "south", "id": "order-17", "amount": 4500},
        ]))
        self.assertEqual(service.get("north", "order-17")["amount"], 1200)
        self.assertEqual(service.get("south", "order-17")["amount"], 4500)

if __name__ == "__main__":
    unittest.main()
