import sqlite3
import unittest
from repository import OrderRepository
from pagination import all_order_ids

class PaginationContract(unittest.TestCase):
    def test_pages_do_not_repeat_boundary_rows(self):
        with sqlite3.connect(":memory:") as db:
            db.execute("CREATE TABLE orders (id INTEGER PRIMARY KEY)")
            db.executemany("INSERT INTO orders VALUES (?)", [(1,), (2,), (3,), (4,), (5,)])
            repo = OrderRepository(db)
            first = repo.page(0, 2)
            second = repo.page(first[-1][0], 2)
            self.assertEqual([row[0] for row in first + second], [1, 2, 3, 4])
            self.assertEqual(list(all_order_ids(repo)), [1, 2, 3, 4, 5])

if __name__ == "__main__":
    unittest.main()
