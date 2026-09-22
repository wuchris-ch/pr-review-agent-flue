import unittest
from payments import receive_payment
from ledger import Ledger

class WebhookContract(unittest.TestCase):
    def test_provider_retry_cannot_double_credit(self):
        ledger = Ledger()
        event = {"id": "evt-100", "account": "customer-9", "amount_cents": 2500}
        receive_payment(ledger, event)
        receive_payment(ledger, dict(event))
        self.assertEqual(ledger.balances["customer-9"], 2500)
        receive_payment(ledger, {**event, "id": "evt-101"})
        self.assertEqual(ledger.balances["customer-9"], 5000)

if __name__ == "__main__":
    unittest.main()
