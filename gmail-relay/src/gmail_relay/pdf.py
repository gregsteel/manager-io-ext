"""PDF -> JPEG conversion via poppler-utils' pdftoppm.

receipt-submission's upload route rejects application/pdf outright (confirmed
against src/app/api/receipts/[id]/image/route.ts), so a PDF attachment's
first page gets rendered to JPEG before relaying."""

from __future__ import annotations

import subprocess
from pathlib import Path


class PdfConversionError(RuntimeError):
    pass


def pdf_first_page_to_jpeg(pdf_path: Path, out_stem: Path, dpi: int = 150) -> Path:
    result = subprocess.run(
        ["pdftoppm", "-jpeg", "-f", "1", "-l", "1", "-r", str(dpi), str(pdf_path), str(out_stem)],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        raise PdfConversionError(result.stderr.strip() or "pdftoppm exited non-zero")
    # pdftoppm appends -1 (single page, -f 1 -l 1) and the format extension.
    produced = out_stem.with_name(f"{out_stem.name}-1.jpg")
    if not produced.exists():
        raise PdfConversionError(f"pdftoppm did not produce the expected {produced}")
    return produced
