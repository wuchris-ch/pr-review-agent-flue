from parsing import parse_count

def make_batch(value: str):
    """Malformed optional configuration means no work."""
    count = parse_count(value)
    return [str(i) for i in range(count)]
