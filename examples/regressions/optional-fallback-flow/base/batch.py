from parsing import parse_count

def make_batch(value: str):
    """Malformed optional configuration means no work."""
    try:
        count = parse_count(value)
    except ValueError:
        count = 0
    return [str(i) for i in range(count)]
