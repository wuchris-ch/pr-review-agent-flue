def parse_count(value: str) -> int:
    try:
        return int(value)
    except ValueError:
        return 0
