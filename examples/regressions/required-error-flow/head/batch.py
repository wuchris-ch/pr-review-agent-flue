from parsing import parse_count

def make_batch(value: str):
    """Malformed required configuration must raise, not create an empty job."""
    count = parse_count(value)
    return list(map(str, range(count)))
