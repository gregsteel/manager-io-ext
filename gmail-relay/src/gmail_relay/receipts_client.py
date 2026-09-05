"""Pushes converted attachment bytes to a Receipts create_receipt uploadUrl.

PUT, raw binary body, Authorization: Bearer <uploadToken>, Content-Type set
to the image mime type — confirmed directly against receipt-submission's own
upload route (src/app/api/receipts/[id]/image/route.ts), which accepts
either PUT or POST, a raw body or multipart/form-data, any image/* mime type,
and rejects application/pdf and anything over 8 MB."""

from __future__ import annotations

import httpx


class ReceiptsUploadError(RuntimeError):
    def __init__(self, status_code: int, body: str) -> None:
        super().__init__(f"Receipts upload HTTP {status_code}: {body}")
        self.status_code = status_code


async def upload_to_receipts(
    http_client: httpx.AsyncClient,
    upload_url: str,
    upload_token: str,
    content: bytes,
    content_type: str,
) -> None:
    resp = await http_client.put(
        upload_url,
        content=content,
        headers={
            "Authorization": f"Bearer {upload_token}",
            "Content-Type": content_type,
        },
    )
    if resp.status_code >= 300:
        raise ReceiptsUploadError(resp.status_code, resp.text)
