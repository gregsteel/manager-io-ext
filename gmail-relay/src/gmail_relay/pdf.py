"""PDF -> JPEG conversion via poppler-utils' pdftoppm.

receipt-submission's upload route rejects application/pdf outright (confirmed
against src/app/api/receipts/[id]/image/route.ts) and stores one image per
receipt, so every page is rendered and stacked vertically into a single JPEG."""

from __future__ import annotations

import subprocess
from pathlib import Path

from PIL import Image


class PdfConversionError(RuntimeError):
    pass


def pdf_to_jpeg(pdf_path: Path, out_stem: Path, dpi: int = 150) -> Path:
    result = subprocess.run(
        ["pdftoppm", "-jpeg", "-r", str(dpi), str(pdf_path), str(out_stem)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise PdfConversionError(result.stderr.strip() or "pdftoppm exited non-zero")
    # pdftoppm names pages <stem>-<n>.jpg with zero-padding to the page-count width.
    pages = sorted(out_stem.parent.glob(f"{out_stem.name}-*.jpg"))
    if not pages:
        raise PdfConversionError("pdftoppm produced no pages")
    if len(pages) == 1:
        return pages[0]

    images = [Image.open(p) for p in pages]
    try:
        width = max(im.width for im in images)
        canvas = Image.new("RGB", (width, sum(im.height for im in images)), "white")
        y = 0
        for im in images:
            canvas.paste(im, ((width - im.width) // 2, y))
            y += im.height
        combined = out_stem.with_name(f"{out_stem.name}-combined.jpg")
        canvas.save(combined, "JPEG", quality=80)
    finally:
        for im in images:
            im.close()
    return combined
