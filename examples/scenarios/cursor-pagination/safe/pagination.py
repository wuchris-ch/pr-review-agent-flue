def all_order_ids(repository, page_size=2):
    cursor = 0
    for _ in range(100):
        rows = repository.page(cursor, page_size)
        if not rows:
            return
        yield from (row[0] for row in rows)
        next_cursor = rows[-1][0]
        if next_cursor <= cursor:
            raise RuntimeError("cursor did not advance")
        cursor = next_cursor
    raise RuntimeError("pagination exceeded safety bound")
