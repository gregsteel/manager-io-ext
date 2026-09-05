"""Shared PDF-convert + Receipts PUT used by both Gmail and Drive relays."""

from __future__ import annotations

from dataclasses import dataclass

import httpx

from gmail_relay.download_dir import JailedTempFile
from gmail_relay.pdf import PdfConversionError, pdf_first_page_to_jpeg
from gmail_relay.receipts_client import ReceiptsUploadError, upload_to_receipts


class RelayUploadError(RuntimeError):
    pass


@dataclass(frozen=True)
class RelayUploadResult:
    bytes_uploaded: int
    converted_from_pdf: bool
    content_type: str


def prepare_receipt_image(
    raw: bytes,
    *,
    source_mime_type: str | None,
    filename: str | None,
    jail: JailedTempFile,
    max_bytes: int,
) -> tuple[bytes, str, bool]:
    """Size-check, optionally convert a PDF's first page, return image bytes.

    Returns `(content, content_type, converted_from_pdf)`.
    """
    if len(raw) > max_bytes:
        raise RelayUploadError(
            f"Attachment is {len(raw)} bytes, over the {max_bytes}-byte limit"
        )

    is_pdf = source_mime_type == "application/pdf" or (filename or "").lower().endswith(
        ".pdf"
    )
    source_path = jail.named(".pdf" if is_pdf else ".bin")
    source_path.write_bytes(raw)

    if is_pdf:
        try:
            jpeg_path = pdf_first_page_to_jpeg(source_path, jail.named(""))
        except PdfConversionError as exc:
            raise RelayUploadError(f"PDF conversion failed: {exc}") from exc
        return jpeg_path.read_bytes(), "image/jpeg", True

    is_image = (source_mime_type or "").startswith("image/")
    content_type = source_mime_type if is_image else "image/jpeg"
    return raw, content_type, False


async def convert_and_upload(
    http_client: httpx.AsyncClient,
    *,
    raw: bytes,
    source_mime_type: str | None,
    filename: str | None,
    upload_url: str,
    upload_token: str,
    jail: JailedTempFile,
    max_bytes: int,
) -> RelayUploadResult:
    content, content_type, converted = prepare_receipt_image(
        raw,
        source_mime_type=source_mime_type,
        filename=filename,
        jail=jail,
        max_bytes=max_bytes,
    )
    try:
        await upload_to_receipts(http_client, upload_url, upload_token, content, content_type)
    except ReceiptsUploadError as exc:
        raise RelayUploadError(f"Receipts upload failed: {exc}") from exc
    return RelayUploadResult(
        bytes_uploaded=len(content),
        converted_from_pdf=converted,
        content_type=content_type,
    )
