"""Generates the demo catalogue, price list and the sample RFQ PDFs.

Output:
  db/21_rfq_seed.sql
  samples/rfq-01-elektro-mont.pdf    (ERP table export, exact codes + customer codes)
  samples/rfq-02-brightline.pdf      (email style bullet list)
  samples/rfq-03-nordic.pdf          (free text, needs the LLM parser)
"""
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

from fpdf import FPDF

ROOT = Path(__file__).resolve().parent.parent
products = []
aliases = []
prices = []


def money(v):
    return Decimal(str(v)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def add(sku, name, category, sales_unit, price, base_unit="PCS", per=1, terms="", tiers=None):
    products.append((sku, name, category, sales_unit, base_unit, per, terms))
    for group, factor in (("STANDARD", Decimal("1")), ("PROJECT", Decimal("0.92"))):
        prices.append((sku, group, 1, money(Decimal(str(price)) * factor)))
        for min_qty, discount in (tiers or []):
            prices.append((sku, group, min_qty, money(Decimal(str(price)) * factor * (1 - Decimal(str(discount))))))


mcb_tiers = [(50, "0.06"), (200, "0.10")]

for xs, price in (("3x1.5", 62), ("3x2.5", 98), ("5x1.5", 98), ("5x2.5", 155)):
    add(f"VX-NYM-{xs.upper()}-R100", f"NYM-J installation cable {xs} mm², ring 100 m", "Cables", "ROLL", price, "M", 100)
for xs, price in (("5x4", 2.60), ("5x6", 3.80), ("5x10", 6.20)):
    add(f"VX-NYM-{xs.upper()}", f"NYM-J installation cable {xs} mm², cut to length", "Cables", "M", price, "M")
for xs, price in (("4x10", 5.40), ("4x16", 8.10), ("4x25", 12.40), ("5x6", 4.30), ("5x10", 6.90)):
    add(f"VX-NYY-{xs.upper()}", f"NYY-J underground cable {xs} mm², cut to length", "Cables", "M", price, "M")
for sec, price in (("1.5", 14), ("2.5", 22), ("4", 34), ("6", 50)):
    for color, code in (("black", "BK"), ("blue", "BU"), ("brown", "BN"), ("grey", "GY"), ("yellow-green", "YG")):
        add(f"VX-H07VK-1X{sec}-{code}", f"H07V-K single core flexible 1x{sec} mm² {color}, roll 100 m",
            "Cables", "ROLL", price, "M", 100)
for xs, price in (("3x1.5", 0.95), ("3x2.5", 1.45)):
    add(f"VX-H05VVF-{xs.upper()}", f"H05VV-F flexible cable {xs} mm² white, cut to length", "Cables", "M", price, "M")
add("VX-UTP-CAT6-305", "UTP installation cable Cat6 U/UTP, box 305 m", "Data", "ROLL", 115, "M", 305, "network lan")
add("VX-FTP-CAT6A-305", "FTP installation cable Cat6A F/UTP, box 305 m", "Data", "ROLL", 210, "M", 305, "network lan")

for curve in ("B", "C"):
    for amp in (6, 10, 13, 16, 20, 25, 32, 40, 50, 63):
        for poles in (1, 3):
            big = amp >= 40
            price = (7.80 if big else 3.20) if poles == 1 else (24.00 if big else 11.50)
            sku = f"VX-MCB-{curve}{amp}-{poles}P"
            add(sku, f"Miniature circuit breaker MCB {curve}{amp} {poles}P 6kA", "Protection", "PCS", price,
                tiers=mcb_tiers)
            aliases.append((f"NRD-6{poles}{amp:02d}{curve}", sku, "MANUFACTURER"))

for poles, base in ((2, 19), (4, 32)):
    for amp, extra in ((25, 0), (40, 2), (63, 10 if poles == 2 else 13)):
        for ma, ma_extra in ((30, 0), (300, 2)):
            sku = f"VX-RCD-{poles}P-{amp}A-{ma}MA"
            add(sku, f"Residual current device RCD {poles}P {amp}A {ma}mA type A", "Protection", "PCS",
                base + extra + ma_extra, tiers=mcb_tiers)
            aliases.append((f"NRD-R{poles}{amp:02d}{ma:03d}", sku, "MANUFACTURER"))

for curve, amp, price in (("B", 16, 24), ("B", 20, 24), ("C", 16, 25), ("C", 20, 25)):
    add(f"VX-RCBO-{curve}{amp}-30MA", f"RCBO {curve}{amp} 30mA 1P+N type A", "Protection", "PCS", price,
        tiers=mcb_tiers)

for dia, price in ((16, 9), (20, 11), (25, 15), (32, 22)):
    add(f"VX-CONF-{dia}-R50", f"Flexible corrugated conduit {dia} mm, roll 50 m", "Conduit", "ROLL", price, "M", 50)
for dia, price in ((16, 1.10), (20, 1.40), (25, 1.90), (32, 2.80)):
    add(f"VX-CONR-{dia}-3M", f"Rigid PVC conduit {dia} mm, length 3 m", "Conduit", "PCS", price)

for size, price in (("2.5x100", 1.20), ("3.6x200", 2.40), ("4.8x300", 4.60), ("7.6x450", 11.00)):
    for color, code in (("black", "BK"), ("natural", "NT")):
        add(f"VX-TIE-{size.replace('.', '')}-{code}", f"Cable tie {size} mm {color}, pack 100", "Fixing", "PACK",
            price, "PCS", 100, "zip tie strap")

for size, ip, price in (("80x80x50", 65, 1.90), ("100x100x50", 65, 2.60), ("150x110x70", 65, 4.20),
                        ("100x100x50", 54, 1.80)):
    add(f"VX-JB-{size.split('x')[0]}-IP{ip}", f"Junction box IP{ip} {size} mm grey", "Boxes", "PCS", price)
add("VX-FLUSHBOX-60", "Flush mounting box 60 mm", "Boxes", "PCS", 0.18, terms="wall box")

add("VX-SOCK-1-WH", "Socket outlet Schuko single, white", "Wiring devices", "PCS", 2.10, terms="power point")
add("VX-SOCK-2-WH", "Socket outlet Schuko double, white", "Wiring devices", "PCS", 4.40, terms="power point")
add("VX-SOCK-2USB-WH", "Socket outlet Schuko double with USB A+C, white", "Wiring devices", "PCS", 19.90)
add("VX-SOCK-IP44-GY", "Surface socket outlet IP44 grey", "Wiring devices", "PCS", 5.20)
add("VX-SW-1W-WH", "Light switch one-way, white", "Wiring devices", "PCS", 1.90)
add("VX-SW-2W-WH", "Light switch two-way, white", "Wiring devices", "PCS", 2.30)

for watt, cct, price in ((36, 4000, 21), (40, 4000, 24), (40, 3000, 24)):
    add(f"VX-LEDP-6060-{watt}W-{cct // 100}K", f"LED panel 600x600 {watt}W {cct}K", "Lighting", "PCS", price,
        terms="troffer ceiling")
add("VX-LEDB-18W-IP65", "LED batten IP65 18W 600 mm", "Lighting", "PCS", 12)
add("VX-LEDB-36W-IP65", "LED batten IP65 36W 1200 mm", "Lighting", "PCS", 16)
add("VX-LEDF-50W-IP65", "LED floodlight 50W IP65", "Lighting", "PCS", 18)
add("VX-LEDF-100W-IP65", "LED floodlight 100W IP65", "Lighting", "PCS", 32)

for thread, price in (("M16", 0.35), ("M20", 0.45), ("M25", 0.70), ("M32", 1.10)):
    add(f"VX-GLAND-{thread}", f"Cable gland {thread} IP68", "Fixing", "PCS", price)

for mods, price in ((12, 18), (24, 32), (36, 48)):
    add(f"VX-DB-S{mods}", f"Distribution board surface {mods} modules IP40", "Enclosures", "PCS", price,
        terms="consumer unit panel")
add("VX-DB-F24", "Distribution board flush 24 modules IP40", "Enclosures", "PCS", 36, terms="consumer unit panel")

for way, price in ((2, 9), (3, 11), (5, 16)):
    add(f"VX-LEVER-{way}W-P50", f"Lever connector {way}-way 0.2-4 mm², pack 50", "Fixing", "PACK", price, "PCS", 50)
add("VX-DIN-35-1M", "DIN rail 35 mm, 1 m", "Enclosures", "PCS", 1.80)

for i, (sku, *_rest) in enumerate(products[:60]):
    aliases.append((f"38600{10000000 + i * 7919:08d}", sku, "EAN"))

customers = [
    (1, "Elektro-Mont d.o.o.", "elektromont.rs", "PROJECT"),
    (2, "Brightline Installations Ltd", "brightline.co.uk", "STANDARD"),
    (3, "Nordic Facility Services AB", "nordicfs.se", "STANDARD"),
]
xref = [
    (1, "EM-10442", "VX-MCB-B16-1P"),
    (1, "EM-10447", "VX-MCB-C32-3P"),
    (1, "EM-10501", "VX-RCD-4P-40A-30MA"),
    (1, "EM-20110", "VX-NYM-3X1.5-R100"),
    (1, "EM-30070", "VX-LEDP-6060-40W-40K"),
]


def q(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, Decimal)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def write_seed():
    lines = ["-- generated by scripts/generate_rfq_data.py, do not edit by hand",
             "TRUNCATE rfq.quote_lines, rfq.quotes, rfq.customer_part_xref, rfq.price_list, rfq.product_aliases,"
             " rfq.products, rfq.customers;",
             "ALTER SEQUENCE rfq.quote_no_seq RESTART WITH 1001;"]
    lines.append("INSERT INTO rfq.customers (id, name, email_domain, price_group) VALUES")
    lines.append(",\n".join(f"({c[0]}, {q(c[1])}, {q(c[2])}, {q(c[3])})" for c in customers) + ";")
    lines.append("INSERT INTO rfq.products (sku, name, category, sales_unit, base_unit, base_qty_per_sales_unit,"
                 " search_terms) VALUES")
    lines.append(",\n".join(f"({q(p[0])}, {q(p[1])}, {q(p[2])}, {q(p[3])}, {q(p[4])}, {p[5]}, {q(p[6])})"
                            for p in products) + ";")
    lines.append("INSERT INTO rfq.product_aliases (alias, sku, kind) VALUES")
    lines.append(",\n".join(f"({q(a[0])}, {q(a[1])}, {q(a[2])})" for a in aliases) + ";")
    lines.append("INSERT INTO rfq.price_list (sku, price_group, min_qty, unit_price) VALUES")
    lines.append(",\n".join(f"({q(p[0])}, {q(p[1])}, {p[2]}, {p[3]})" for p in prices) + ";")
    lines.append("INSERT INTO rfq.customer_part_xref (customer_id, customer_code, sku) VALUES")
    lines.append(",\n".join(f"({x[0]}, {q(x[1])}, {q(x[2])})" for x in xref) + ";")
    (ROOT / "db" / "21_rfq_seed.sql").write_text("\n".join(lines) + "\n", encoding="utf-8")


FONT_CANDIDATES = [
    ("C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf"),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
    ("/usr/share/fonts/dejavu/DejaVuSans.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"),
    ("/Library/Fonts/Arial.ttf", "/Library/Fonts/Arial Bold.ttf"),
    ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
]


def find_fonts():
    for regular, bold in FONT_CANDIDATES:
        if Path(regular).exists() and Path(bold).exists():
            return regular, bold
    raise SystemExit("No Unicode TTF font found (Arial or DejaVu Sans). Install one or add its path to FONT_CANDIDATES.")


class Doc(FPDF):
    def __init__(self, company, address):
        super().__init__(format="A4")
        self.company = company
        self.address = address
        self.set_auto_page_break(True, 18)
        regular, bold = find_fonts()
        self.add_font("DejaVu", "", regular)
        self.add_font("DejaVu", "B", bold)

    def header(self):
        self.set_font("DejaVu", "B", 14)
        self.cell(0, 7, self.company, new_x="LMARGIN", new_y="NEXT")
        self.set_font("DejaVu", "", 9)
        self.cell(0, 5, self.address, new_x="LMARGIN", new_y="NEXT")
        self.ln(4)


def rfq_01():
    d = Doc("Elektro-Mont d.o.o.", "Bulevar Mihajla Pupina 10, 11070 Novi Beograd, Serbia  |  nabavka@elektromont.rs")
    d.add_page()
    d.set_font("DejaVu", "B", 12)
    d.cell(0, 7, "REQUEST FOR QUOTATION  RFQ-2026-0917", new_x="LMARGIN", new_y="NEXT")
    d.set_font("DejaVu", "", 9)
    d.cell(0, 5, "Project: Residential building Lamela B, Novi Beograd", new_x="LMARGIN", new_y="NEXT")
    d.cell(0, 5, "Date: 17.09.2026    Requested by: M. Jovanović    Delivery: DDP site, week 41", new_x="LMARGIN",
           new_y="NEXT")
    d.ln(3)
    rows = [
        ("1", "EM-10442", "MCB B16 1P 6kA", "40", "pcs"),
        ("2", "EM-10447", "MCB C32 3P", "6", "pcs"),
        ("3", "VX-RCD-4P-40A-30MA", "RCD 4P 40A 30mA type A", "4", "pcs"),
        ("4", "", "NYM-J 3x1,5 mm2", "250", "m"),
        ("5", "", "NYM-J 5x2,5 mm2", "120", "m"),
        ("6", "NRD-6120C", "Circuit breaker C20 1P", "10", "pcs"),
        ("7", "EM-10442", "MCB B10 1P", "25", "pcs"),
        ("8", "", "Flexible conduit 20mm", "300", "m"),
        ("9", "", "Cable tie 4.8x300 black", "1000", "pcs"),
        ("10", "EM-30070", "LED panel 600x600 40W 4000K", "24", "pcs"),
        ("11", "", "Junction box IP65 100x100", "30", "pcs"),
        ("12", "", "Surge protection device T2 3P+N", "2", "pcs"),
        ("13", "", "Socket outlet double white", "50", "pcs"),
        ("14", "", "NYY-J 4x16 mm2", "85", "m"),
        ("15", "EM-40020", "Lever connector", "200", "pcs"),
        ("16", "", "H07V-K 1x2,5 blue", "500", "m"),
        ("17", "", "LED panel 600x600 36W 4000K", "2", "box"),
    ]
    widths = (12, 42, 90, 20, 16)
    d.set_font("DejaVu", "B", 9)
    for w, h in zip(widths, ("Pos", "Item code", "Description", "Qty", "Unit")):
        d.cell(w, 7, h, border=1, align="C" if h != "Description" else "L")
    d.ln()
    d.set_font("DejaVu", "", 9)
    for r in rows:
        for w, v, a in zip(widths, r, ("C", "L", "L", "R", "C")):
            d.cell(w, 6.5, v, border=1, align=a)
        d.ln()
    d.ln(4)
    d.multi_cell(0, 5, "Please quote net prices in EUR, valid 30 days. Partial deliveries are acceptable. "
                       "Reference RFQ-2026-0917 on the quotation.")
    d.output(str(ROOT / "samples" / "rfq-01-elektro-mont.pdf"))


def rfq_02():
    d = Doc("Brightline Installations Ltd", "Unit 4, Riverside Park, Leeds LS10 1AB, United Kingdom")
    d.add_page()
    d.set_font("DejaVu", "", 10)
    body = [
        "From: John Carter <john.carter@brightline.co.uk>",
        "Subject: Quote request - Riverside offices, phase 2",
        "",
        "Hi team,",
        "",
        "Could you please send us a quote for the following items for the Riverside project:",
        "",
        "- 12 x RCBO B16 30mA",
        "- 400m H07V-K 1.5mm2 yellow/green",
        "- 60 pcs cable gland M20",
        "- 2 x distribution board 24 modules surface IP40",
        "- 150 m UTP cat6",
        "- 20x LED batten 36W IP65",
        "- 10 x MCB C16 3-pole",
        "",
        "Delivery to site by 10 October if possible.",
        "",
        "Thanks,",
        "John Carter",
        "Purchasing, Brightline Installations",
    ]
    for line in body:
        d.cell(0, 6, line, new_x="LMARGIN", new_y="NEXT")
    d.output(str(ROOT / "samples" / "rfq-02-brightline.pdf"))


def rfq_03():
    d = Doc("Nordic Facility Services AB", "Kungsgatan 12, 111 43 Stockholm, Sweden")
    d.add_page()
    d.set_font("DejaVu", "", 10)
    d.multi_cell(0, 6,
        "Hello,\n\n"
        "We are refurbishing the lighting and small power in our Belgrade office and would like a price for "
        "roughly the following. We will need around two hundred meters of NYM 3x2.5 cable and about thirty "
        "B16 single pole breakers. For the ceiling we plan eighteen 600 by 600 LED panels, 40 watt, neutral "
        "white 4000K. Please add four 4-pole residual current devices, 40 amp, 30mA, and six surface IP44 "
        "sockets for the storage room.\n\n"
        "If you have an alternative for the panels with better efficiency, feel free to suggest it.\n\n"
        "Best regards,\nAnna Lindqvist\nFacility Manager")
    d.output(str(ROOT / "samples" / "rfq-03-nordic.pdf"))


if __name__ == "__main__":
    write_seed()
    rfq_01()
    rfq_02()
    rfq_03()
    print(f"{len(products)} products, {len(aliases)} aliases, {len(prices)} price rows")
