def receive_payment(ledger, event):
    event_id = event["id"]
    if ledger.has_event(event_id):
        return {"accepted": True, "duplicate": True}
    ledger.credit(event_id, event["account"], event["amount_cents"])
    return {"accepted": True, "duplicate": False}
