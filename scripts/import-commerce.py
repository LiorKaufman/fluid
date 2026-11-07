#!/usr/bin/env python3
"""Fetch UCI's real retail workbook and retain complete invoices, without pandas.

The Rust host performs aggregation, money calculations, and review rules.
This script only decodes XLSX cells and chooses a reproducible, attributed extract.
"""
import argparse
from collections import Counter
from datetime import datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import io
import json
from pathlib import Path
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
URL = "https://archive.ics.uci.edu/static/public/352/online%2Bretail.zip"
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--invoices", type=int, default=500)
    args = parser.parse_args()
    archive = ROOT / ".fluid/datasets/online-retail.zip"
    archive.parent.mkdir(parents=True, exist_ok=True)
    if args.download or not archive.exists():
        with urllib.request.urlopen(URL, timeout=120) as response:
            archive.write_bytes(response.read())
    archive_bytes = archive.read_bytes()
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as outer:
        workbook = outer.read(next(n for n in outer.namelist() if n.endswith(".xlsx")))
    rows, selected, full_count = [], set(), 0
    with zipfile.ZipFile(io.BytesIO(workbook)) as book:
        strings = []
        with book.open("xl/sharedStrings.xml") as source:
            for _, element in ET.iterparse(source, events=("end",)):
                if element.tag == f"{{{NS['m']}}}si":
                    strings.append("".join(element.itertext()))
                    element.clear()
        with book.open("xl/worksheets/sheet1.xml") as source:
            for _, element in ET.iterparse(source, events=("end",)):
                if element.tag != f"{{{NS['m']}}}row":
                    continue
                number = int(element.attrib["r"])
                cells = {}
                for cell in element.findall("m:c", NS):
                    column = "".join(c for c in cell.attrib["r"] if c.isalpha())
                    value = cell.find("m:v", NS)
                    value = value.text if value is not None else None
                    if cell.attrib.get("t") == "s" and value is not None:
                        value = strings[int(value)]
                    cells[column] = value
                element.clear()
                if number == 1:
                    assert cells["A"] == "InvoiceNo" and cells["F"] == "UnitPrice"
                    continue
                if not cells.get("A"):
                    continue
                full_count += 1
                invoice = cells["A"]
                if invoice not in selected and len(selected) < args.invoices:
                    selected.add(invoice)
                if invoice not in selected:
                    continue
                seconds = int((Decimal(cells["E"]) * 86400).quantize(Decimal(1), rounding=ROUND_HALF_UP))
                date = datetime(1899, 12, 30) + timedelta(seconds=seconds)
                price = Decimal(cells["F"])
                micros = int((price * 1_000_000).quantize(Decimal(1), rounding=ROUND_HALF_UP))
                if abs(price - Decimal(micros)/1_000_000) > Decimal("0.000001"):
                    raise ValueError(f"Unsupported price precision on row {number}")
                rows.append({
                    "row": number,
                    "invoiceNo": invoice,
                    "stockCode": cells.get("B") or "",
                    "description": cells.get("C") or "",
                    "quantity": int(Decimal(cells["D"])),
                    "invoiceDate": date.isoformat(timespec="seconds"),
                    "unitPriceMicros": micros,
                    "customerId": cells.get("G"),
                    "country": cells.get("H") or "Unknown",
                })
    assert full_count == 541_909, f"Upstream row count changed: {full_count}"
    result = {
        "source": {
            "title": "Online Retail",
            "creator": "Daqing Chen",
            "citation": "Chen, D. (2015). Online Retail [Dataset]. UCI Machine Learning Repository. https://doi.org/10.24432/C5BW33",
            "url": "https://archive.ics.uci.edu/dataset/352/online%2Bretail",
            "downloadUrl": URL,
            "doi": "10.24432/C5BW33",
            "license": "CC BY 4.0",
            "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
            "archiveSha256": hashlib.sha256(archive_bytes).hexdigest(),
            "workbookSha256": hashlib.sha256(workbook).hexdigest(),
            "fullLineCount": full_count,
            "sampleLineCount": len(rows),
            "sampleInvoiceCount": len(selected),
            "selection": f"First {len(selected)} distinct invoice numbers in workbook order; all lines for those invoice numbers are retained.",
            "periodStart": min(r["invoiceDate"] for r in rows),
            "periodEnd": max(r["invoiceDate"] for r in rows),
            "currency": "GBP",
            "moneyMethod": "Source prices are represented in millionths of a pound. Quantity × price is rounded to pence per line, half away from zero, then summed per invoice.",
            "notice": "Historical transactions, not live orders. Review tasks and their statuses are a demo workflow added by Fluid; they do not imply these historical orders were left unresolved.",
        },
        "lines": rows,
    }
    destination = ROOT / "src/commerce/data/retail.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result, separators=(",", ":"), ensure_ascii=False)+"\n")
    (destination.parent / "source.json").write_text(json.dumps(result["source"], indent=2)+"\n")
    print(json.dumps({**result["source"], "countries": dict(Counter(r["country"] for r in rows)), "bytes": destination.stat().st_size}, indent=2))


if __name__ == "__main__":
    main()
