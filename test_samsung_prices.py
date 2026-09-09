import sqlite3
import unittest

from repair_samsung_history import repair
from spareprice import parse_samsung_row


class SamsungPriceTests(unittest.TestCase):
    def test_storage_variants_use_price_cell(self):
        for storage, amount, expected in [('256 GB', '39,670', 39670),
                                          ('512 GB', '43,640', 43640),
                                          ('1 TB', '49,370', 49370)]:
            part, _, value = parse_samsung_row('\u2022 ' + storage, amount)
            self.assertEqual(part, 'Motherboard - ' + storage)
            self.assertEqual(value, expected)

    def test_regular_and_unavailable_parts(self):
        self.assertEqual(parse_samsung_row('Battery', '2,500')[2], 2500)
        self.assertIsNone(parse_samsung_row('- 256 GB', 'N/A')[2])
        with self.assertRaises(ValueError):
            parse_samsung_row('Motherboard', '256 GB39,670')

    def test_repair_is_scoped_and_preserves_history(self):
        conn = sqlite3.connect(':memory:')
        conn.execute('CREATE TABLE price_history (id INTEGER, brand TEXT, part TEXT, price TEXT, price_value REAL, date TEXT)')
        conn.executemany('INSERT INTO price_history VALUES (?, ?, ?, ?, ?, ?)', [
            (1, 'Samsung', '- 256 GB', '- 256 GB 39,670', 256, '2026-08-14'),
            (2, 'Apple', '- 256 GB', '- 256 GB 39,670', 256, '2026-08-14'),
            (3, 'Samsung', '- 1 TB', '- 1 TB unavailable', 1, '2026-08-14'),
        ])
        self.assertEqual(repair(conn), 1)
        self.assertEqual(conn.execute('SELECT part,price_value,date FROM price_history WHERE id=1').fetchone(),
                         ('Motherboard - 256 GB', 39670, '2026-08-14'))
        self.assertEqual(conn.execute('SELECT price_value FROM price_history WHERE id=2').fetchone()[0], 256)
        self.assertEqual(repair(conn), 0)
        conn.close()


if __name__ == '__main__':
    unittest.main()
