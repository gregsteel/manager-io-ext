import pytest

from gmail_relay.download_dir import JailedTempFile
from gmail_relay.relay_upload import RelayUploadError, prepare_receipt_image


def test_prepare_image_passthrough(tmp_path):
    jail = JailedTempFile(tmp_path)
    content, content_type, converted = prepare_receipt_image(
        b"jpeg-bytes",
        source_mime_type="image/jpeg",
        filename="scan.jpg",
        jail=jail,
        max_bytes=100,
    )
    assert content == b"jpeg-bytes"
    assert content_type == "image/jpeg"
    assert converted is False


def test_prepare_image_rejects_oversize(tmp_path):
    jail = JailedTempFile(tmp_path)
    with pytest.raises(RelayUploadError, match="over the"):
        prepare_receipt_image(
            b"12345",
            source_mime_type="image/jpeg",
            filename="scan.jpg",
            jail=jail,
            max_bytes=4,
        )
