#!/usr/bin/env python3
"""Ladder A/B benchmark: writes a small invented Python project with a test suite and three tasks.

    python3 -I make_repo.py <dest>

The project ("shelf", a bookshop inventory) is standard library only; `make test` runs its suite. Three tasks
(TASKS below) each start from this same commit:
  feature  - discount codes across four modules, specified by tests/test_discount.py (failing until done)
  fix      - one failing test caused by a bug in shelf/util.py
  rename   - rename calc_tot -> calculate_total in 12 modules and drop unused imports, checked by tests/test_names.py
  multi    - four new independent modules (search, csvio, stats, receipt), each specified by its own failing test
             module: big enough, and split cleanly enough by file, that delegating (or swarm mode) should pay
"""
import os
import subprocess
import sys
import textwrap

FILES = {
    "Makefile": "test:\n\tpython3 -m unittest discover -s tests -q\n",
    "README.md": "# shelf\n\nA tiny bookshop inventory. `make test` runs the tests.\n",
    "shelf/__init__.py": "",
    "shelf/models.py": '''
        from dataclasses import dataclass


        @dataclass(frozen=True)
        class Book:
            isbn: str
            title: str
            price_cents: int


        @dataclass
        class Line:
            book: Book
            qty: int
    ''',
    "shelf/store.py": '''
        from shelf.models import Book, Line


        class Store:
            def __init__(self):
                self.books = {}
                self.cart = []

            def add_book(self, book: Book):
                self.books[book.isbn] = book

            def add_to_cart(self, isbn: str, qty: int = 1):
                self.cart.append(Line(self.books[isbn], qty))
    ''',
    "shelf/pricing.py": '''
        from shelf.legacy.totals import calc_tot


        def total(lines):
            """Cart total in cents."""
            return calc_tot([(l.book.price_cents, l.qty) for l in lines])
    ''',
    "shelf/report.py": '''
        from shelf.pricing import total
        from shelf.util import cents


        def summary(store):
            rows = [f"{l.qty} x {l.book.title}" for l in store.cart]
            rows.append(f"Total: {cents(total(store.cart))}")
            return "\\n".join(rows)
    ''',
    "shelf/util.py": '''
        import datetime


        def cents(n: int) -> str:
            """1234 -> '$12.34'."""
            return f"${n // 100}.{n % 100:02d}"


        def parse_day(s: str) -> datetime.date:
            """'2026-03-09' -> date(2026, 3, 9)."""
            y, m, d = s.split("-")
            return datetime.date(int(y), int(m), int(d) - 1)
    ''',
    "shelf/legacy/__init__.py": "",
    "shelf/legacy/totals.py": '''
        import os


        def calc_tot(pairs):
            return sum(p * q for p, q in pairs)
    ''',
}
# Twelve modules that all use calc_tot (the rename task), half with an unused `import os`.
for i, name in enumerate(["tax", "shipping", "gift", "bulk", "member", "season", "export", "audit", "refund", "bundle", "rental", "preorder"]):
    unused = "import os\n" if i % 2 == 0 else ""
    FILES[f"shelf/legacy/{name}.py"] = (
        f"{unused}from shelf.legacy.totals import calc_tot\n\n\n"
        f"def {name}_total(pairs):\n"
        f'    """{name.title()} total: calc_tot of the pairs, then the {name} rule."""\n'
        f"    return calc_tot(pairs) + {i}\n"
    )
FILES["tests/__init__.py"] = ""
FILES["tests/test_core.py"] = '''
    import unittest
    from shelf.models import Book
    from shelf.store import Store
    from shelf.report import summary
    from shelf.legacy import tax, preorder


    class Core(unittest.TestCase):
        def setUp(self):
            self.s = Store()
            self.s.add_book(Book("1", "Dune", 1250))
            self.s.add_book(Book("2", "Emma", 799))

        def test_summary(self):
            self.s.add_to_cart("1", 2)
            self.s.add_to_cart("2")
            self.assertEqual(summary(self.s), "2 x Dune\\n1 x Emma\\nTotal: $32.99")

        def test_legacy(self):
            self.assertEqual(tax.tax_total([(100, 2)]), 200)
            self.assertEqual(preorder.preorder_total([(100, 1)]), 111)
'''
FILES["tests/test_util.py"] = '''
    import datetime
    import unittest
    from shelf.util import cents, parse_day


    class Util(unittest.TestCase):
        def test_cents(self):
            self.assertEqual(cents(1234), "$12.34")
            self.assertEqual(cents(5), "$0.05")

        def test_parse_day(self):
            self.assertEqual(parse_day("2026-03-09"), datetime.date(2026, 3, 9))
'''
FILES["tests/test_discount.py"] = '''
    import unittest
    from shelf.models import Book, Discount
    from shelf.store import Store
    from shelf.pricing import total
    from shelf.report import summary


    class DiscountCodes(unittest.TestCase):
        def setUp(self):
            self.s = Store()
            self.s.add_book(Book("1", "Dune", 1000))
            self.s.add_to_cart("1", 3)

        def test_model(self):
            d = Discount("SPRING", 10)
            self.assertEqual((d.code, d.percent), ("SPRING", 10))

        def test_store_applies_known_codes_only(self):
            self.s.add_discount(Discount("SPRING", 10))
            self.assertTrue(self.s.apply_code("spring"))  # codes are case-insensitive
            self.assertFalse(self.s.apply_code("NOPE"))
            self.assertEqual(self.s.discount, Discount("SPRING", 10))

        def test_total_with_discount_rounds_down_to_the_cent(self):
            self.assertEqual(total(self.s.cart, Discount("X", 15)), 2550)
            self.assertEqual(total(self.s.cart, Discount("Y", 33)), 2010)
            self.assertEqual(total(self.s.cart), 3000)

        def test_summary_shows_the_discount(self):
            self.s.add_discount(Discount("SPRING", 10))
            self.s.apply_code("SPRING")
            self.assertEqual(summary(self.s), "3 x Dune\\nDiscount: SPRING (-10%)\\nTotal: $27.00")
'''
FILES["tests/test_names.py"] = '''
    import pathlib
    import unittest

    ROOT = pathlib.Path(__file__).resolve().parent.parent / "shelf"


    class Names(unittest.TestCase):
        def test_no_calc_tot_left(self):
            left = [str(p) for p in ROOT.rglob("*.py") if "calc_tot" in p.read_text()]
            self.assertEqual(left, [])

        def test_calculate_total_used(self):
            n = sum("calculate_total" in p.read_text() for p in ROOT.rglob("*.py"))
            self.assertGreaterEqual(n, 14)

        def test_no_unused_os_import_in_legacy(self):
            bad = [p.name for p in (ROOT / "legacy").glob("*.py") if "import os" in p.read_text()]
            self.assertEqual(bad, [])
'''

TASKS = {
    "feature": "Add discount codes to shelf, as tests/test_discount.py specifies: a Discount model, Store.add_discount / apply_code / discount, pricing.total(lines, discount=None), and the Discount line in report.summary. Do not change the tests. Everything else must keep passing.",
    "fix": "tests/test_util.py has a failing test. Find the cause and fix the code (not the test). Everything else must keep passing.",
    "multi": "Add four new modules to shelf, each specified by its own test file: shelf/search.py (tests/test_search.py), shelf/csvio.py (tests/test_csvio.py), shelf/stats.py (tests/test_stats.py) and shelf/receipt.py (tests/test_receipt.py). Do not change the tests. `make test` must pass at the end.",
    "rename": "Rename the function calc_tot to calculate_total everywhere in shelf/ (definition and every use), and remove the unused `import os` lines in shelf/legacy/. Do not touch tests/. Then tests/test_names.py and the rest of the suite must pass.",
}
# The multi task: four new modules, each specified by its own test module.
FILES["tests/test_search.py"] = '''
    import unittest
    from shelf.models import Book
    from shelf.store import Store
    from shelf.search import search, by_price


    class Search(unittest.TestCase):
        def setUp(self):
            self.s = Store()
            for isbn, title, p in [("1", "Dune Messiah", 1250), ("2", "Dune", 999), ("3", "Emma", 799), ("4", "The Dune Encyclopedia", 1999), ("5", "Middlemarch", 999)]:
                self.s.add_book(Book(isbn, title, p))

        def test_all_words_case_insensitive_sorted_by_title(self):
            self.assertEqual([b.title for b in search(self.s, "dune")], ["Dune", "Dune Messiah", "The Dune Encyclopedia"])
            self.assertEqual([b.title for b in search(self.s, "DUNE messiah")], ["Dune Messiah"])
            self.assertEqual(search(self.s, "nothing"), [])

        def test_empty_query_returns_everything_sorted(self):
            self.assertEqual([b.isbn for b in search(self.s, "  ")], ["2", "1", "3", "5", "4"])

        def test_by_price_inclusive_then_by_title(self):
            self.assertEqual([b.title for b in by_price(self.s, 900, 1250)], ["Dune", "Middlemarch", "Dune Messiah"])
            self.assertEqual(by_price(self.s, 5000, 6000), [])
            with self.assertRaises(ValueError):
                by_price(self.s, 10, 5)
'''
FILES["tests/test_csvio.py"] = '''
    import unittest
    from shelf.models import Book
    from shelf.store import Store
    from shelf.csvio import export_csv, import_csv


    class Csv(unittest.TestCase):
        def setUp(self):
            self.s = Store()
            self.s.add_book(Book("9", "War, and Peace", 1500))
            self.s.add_book(Book("1", "Emma", 799))

        def test_export_sorted_by_isbn_with_quoting(self):
            self.assertEqual(export_csv(self.s), 'isbn,title,price_cents\\n1,Emma,799\\n9,"War, and Peace",1500\\n')

        def test_import_counts_new_books_and_skips_known_isbns(self):
            n = import_csv(self.s, 'isbn,title,price_cents\\n1,Emma again,1\\n2,"Dune, Part One",999\\n3,Ulysses,1299\\n')
            self.assertEqual(n, 2)
            self.assertEqual(self.s.books["2"].title, "Dune, Part One")
            self.assertEqual(self.s.books["1"].title, "Emma")

        def test_round_trip(self):
            t = Store()
            self.assertEqual(import_csv(t, export_csv(self.s)), 2)
            self.assertEqual(export_csv(t), export_csv(self.s))

        def test_bad_price_raises_and_adds_nothing(self):
            with self.assertRaises(ValueError):
                import_csv(self.s, 'isbn,title,price_cents\\n5,Ok,100\\n6,Bad,abc\\n')
            self.assertNotIn("5", self.s.books)
'''
FILES["tests/test_stats.py"] = '''
    import unittest
    from shelf.models import Book
    from shelf.store import Store
    from shelf.stats import inventory_value, price_stats, histogram


    class Stats(unittest.TestCase):
        def setUp(self):
            self.s = Store()
            for i, p in enumerate([500, 799, 999, 1250, 1999]):
                self.s.add_book(Book(str(i), f"B{i}", p))

        def test_inventory_value(self):
            self.assertEqual(inventory_value(self.s), 5547)
            self.assertEqual(inventory_value(Store()), 0)

        def test_price_stats(self):
            self.assertEqual(price_stats(self.s), {"min": 500, "max": 1999, "mean": 1109, "median": 999})
            self.s.add_book(Book("x", "X", 1000))
            self.assertEqual(price_stats(self.s)["median"], 999)  # even count: the lower middle
            with self.assertRaises(ValueError):
                price_stats(Store())

        def test_histogram_buckets_sorted(self):
            self.assertEqual(histogram(self.s, 500), {500: 2, 1000: 1, 1500: 1})
            self.assertEqual(list(histogram(self.s, 1000)), [0, 1000])
            with self.assertRaises(ValueError):
                histogram(self.s, 0)
'''
FILES["tests/test_receipt.py"] = '''
    import unittest
    from shelf.models import Book
    from shelf.store import Store
    from shelf.receipt import receipt


    class Receipt(unittest.TestCase):
        def setUp(self):
            self.s = Store()
            self.s.add_book(Book("1", "Dune", 1250))
            self.s.add_book(Book("2", "The Remarkably Long Title Of A Book", 799))

        def test_lines_are_padded_to_the_width(self):
            self.s.add_to_cart("1", 2)
            out = receipt(self.s, width=24).split("\\n")
            self.assertEqual(out, ["Dune          2 x $12.50", "-" * 24, "Total             $25.00"])
            self.assertTrue(all(len(l) == 24 for l in out))

        def test_long_titles_are_cut_with_an_ellipsis(self):
            self.s.add_to_cart("2")
            first = receipt(self.s, width=24).split("\\n")[0]
            self.assertEqual(first, "The Remarkabl… 1 x $7.99")
            self.assertEqual(len(first), 24)

        def test_empty_cart(self):
            self.assertEqual(receipt(self.s, width=12), "-" * 12 + "\\nTotal  $0.00")
'''

# Which test modules must still fail on the untouched repo (sanity check of the setup) - others must pass.
FAIL_AT_START = {"feature": ["tests.test_discount"], "fix": ["tests.test_util"], "rename": ["tests.test_names"], "multi": ["tests.test_search", "tests.test_csvio", "tests.test_stats", "tests.test_receipt"]}


def main():
    dest = os.path.abspath(sys.argv[1])
    os.makedirs(dest, exist_ok=False)
    for rel, body in FILES.items():
        p = os.path.join(dest, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write(textwrap.dedent(body).lstrip("\n"))
    run = lambda *a: subprocess.run(a, cwd=dest, check=True, capture_output=True)
    run("git", "init", "-q")
    run("git", "add", "-A")
    run("git", "-c", "user.name=bench", "-c", "user.email=bench@example.invalid", "commit", "-qm", "shelf")
    print(dest)


if __name__ == "__main__":
    main()
