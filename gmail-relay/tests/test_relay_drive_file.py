from dataclasses import dataclass

import pytest

from gmail_relay.drive_client import DriveApiError, DriveFileDownload
from gmail_relay.relay_upload import RelayUploadResult
from gmail_relay.server import relay_drive_file, reset_state

FILE_ID = "1fileIdxxxxxxxxxxxx"


@dataclass
class _FakeDrive:
    downloaded: DriveFileDownload | None = None
    download_error: DriveApiError | None = None
    delete_error: DriveApiError | None = None
    deleted_ids: list[str] | None = None

    def __post_init__(self) -> None:
        if self.deleted_ids is None:
            self.deleted_ids = []

    async def download(self, file_id: str) -> DriveFileDownload:
        if self.download_error:
            raise self.download_error
        assert self.downloaded is not None
        assert file_id == FILE_ID
        return self.downloaded

    async def delete_file(self, file_id: str) -> None:
        if self.delete_error:
            raise self.delete_error
        self.deleted_ids.append(file_id)


@pytest.fixture(autouse=True)
def _reset():
    reset_state()
    yield
    reset_state()


@pytest.mark.asyncio
async def test_relay_drive_file_uploads_then_deletes(monkeypatch, tmp_path):
    fake = _FakeDrive(
        downloaded=DriveFileDownload(
            file_id=FILE_ID,
            name="scan.jpg",
            mime_type="image/jpeg",
            content=b"jpeg-bytes",
        )
    )
    uploaded: list[tuple] = []

    async def _upload(*args, **kwargs):
        uploaded.append((args, kwargs))
        return RelayUploadResult(
            bytes_uploaded=10, converted_from_pdf=False, content_type="image/jpeg"
        )

    monkeypatch.setenv("RELAY_DOWNLOAD_DIR", str(tmp_path / "jail"))
    monkeypatch.setattr("gmail_relay.server.get_drive_client", lambda: fake)
    monkeypatch.setattr("gmail_relay.server.convert_and_upload", _upload)

    result = await relay_drive_file(
        drive_url=f"https://drive.google.com/file/d/{FILE_ID}/view",
        upload_url="https://receipts.example/api/receipts/abc/image",
        upload_token="tok",
    )

    assert result["ok"] is True
    assert result["driveFileDeleted"] is True
    assert result["driveFileId"] == FILE_ID
    assert result["filename"] == "scan.jpg"
    assert fake.deleted_ids == [FILE_ID]
    assert len(uploaded) == 1


@pytest.mark.asyncio
async def test_relay_drive_file_does_not_delete_when_upload_fails(monkeypatch, tmp_path):
    from gmail_relay.relay_upload import RelayUploadError

    fake = _FakeDrive(
        downloaded=DriveFileDownload(
            file_id=FILE_ID,
            name="scan.jpg",
            mime_type="image/jpeg",
            content=b"jpeg-bytes",
        )
    )

    async def _upload(*args, **kwargs):
        raise RelayUploadError("Receipts upload failed: HTTP 401")

    monkeypatch.setenv("RELAY_DOWNLOAD_DIR", str(tmp_path / "jail"))
    monkeypatch.setattr("gmail_relay.server.get_drive_client", lambda: fake)
    monkeypatch.setattr("gmail_relay.server.convert_and_upload", _upload)

    result = await relay_drive_file(
        drive_url=FILE_ID,
        upload_url="https://receipts.example/api/receipts/abc/image",
        upload_token="tok",
    )

    assert result["ok"] is False
    assert fake.deleted_ids == []


@pytest.mark.asyncio
async def test_relay_drive_file_warns_when_delete_forbidden(monkeypatch, tmp_path):
    fake = _FakeDrive(
        downloaded=DriveFileDownload(
            file_id=FILE_ID,
            name="shared.jpg",
            mime_type="image/jpeg",
            content=b"jpeg-bytes",
        ),
        delete_error=DriveApiError(403, "insufficient permissions"),
    )

    async def _upload(*args, **kwargs):
        return RelayUploadResult(
            bytes_uploaded=10, converted_from_pdf=False, content_type="image/jpeg"
        )

    monkeypatch.setenv("RELAY_DOWNLOAD_DIR", str(tmp_path / "jail"))
    monkeypatch.setattr("gmail_relay.server.get_drive_client", lambda: fake)
    monkeypatch.setattr("gmail_relay.server.convert_and_upload", _upload)

    result = await relay_drive_file(
        drive_url=FILE_ID,
        upload_url="https://receipts.example/api/receipts/abc/image",
        upload_token="tok",
    )

    assert result["ok"] is True
    assert result["driveFileDeleted"] is False
    assert "deleting the Drive file failed" in result["warning"]


@pytest.mark.asyncio
async def test_relay_drive_file_rejects_folder_link(tmp_path, monkeypatch):
    monkeypatch.setenv("RELAY_DOWNLOAD_DIR", str(tmp_path / "jail"))
    result = await relay_drive_file(
        drive_url="https://drive.google.com/drive/folders/1abc",
        upload_url="https://receipts.example/api/receipts/abc/image",
        upload_token="tok",
    )
    assert result["ok"] is False
    assert "folder" in result["error"]


def test_oauth_init_default_includes_drive():
    # Guard the consent-script default so a scope widening isn't silently lost.
    from pathlib import Path

    script = Path(__file__).resolve().parents[1] / "scripts" / "gmail_oauth_init.py"
    text = script.read_text()
    assert 'default="gmail.modify,drive"' in text
