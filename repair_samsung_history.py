"""Repair legacy Samsung storage rows using their saved source prices."""

import argparse
from datetime import datetime, timezone
from pathlib import Path
import re
import sqlite3

from spareprice import parse_samsung_row


def repair(conn: sqlite3.Connection) -> int:
    updates = []
    for row_id, part, price in conn.execute(
        "SELECT id, part, price FROM price_history WHERE brand = 'Samsung'"
    ):
        if not re.fullmatch(r"-\s*\d+\s*(GB|TB)", part, re.IGNORECASE):
            continue
        if not price or not price.startswith(part + " "):
            continue
        amount = price[len(part):].strip()
        # Only recover an unambiguous amount from the original stored text.
        if not re.fullmatch(r"(?:INR\s*|Rs\.?\s*|\u20b9\s*)?\d[\d,]*(?:\.\d{1,2})?", amount):
            continue
        new_part, new_price, value = parse_samsung_row(part, amount)
        updates.append((new_part, new_price, value, row_id))
    with conn:
        conn.executemany(
            "UPDATE price_history SET part=?, price=?, price_value=? WHERE id=?",
            updates,
        )
    return len(updates)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, default=Path('price_history.sqlite3'))
    args = parser.parse_args()
    if not args.db.is_file():
        parser.error(f'Database does not exist: {args.db}')
    backup_dir = args.db.parent / 'backups'
    backup_dir.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = backup_dir / f'{args.db.stem}-before-samsung-repair-{stamp}.sqlite3'
    with sqlite3.connect(args.db) as conn:
        with sqlite3.connect(backup) as snapshot:
            conn.backup(snapshot)
        print(f'Backup: {backup}')
        print(f'Repaired {repair(conn)} Samsung history rows; original dates preserved.')
