class Ledger:
    def __init__(self):
        self.events = set()
        self.balances = {}

    def has_event(self, event_id):
        return event_id in self.events

    def credit(self, event_id, account, amount_cents):
        self.events.add(event_id)
        self.balances[account] = self.balances.get(account, 0) + amount_cents
