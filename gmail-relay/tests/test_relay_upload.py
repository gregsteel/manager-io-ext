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


def test_pdf_to_jpeg_stitches_all_pages(tmp_path):
    from PIL import Image

    from gmail_relay import pdf

    imgs = [Image.new("RGB", (100, 200), c) for c in ("red", "blue", "green")]
    pdf_path = tmp_path / "in.pdf"
    imgs[0].save(pdf_path, "PDF", save_all=True, append_images=imgs[1:], resolution=72)
    out = pdf.pdf_to_jpeg(pdf_path, tmp_path / "out", dpi=72)
    with Image.open(out) as im:
        assert im.width >= 100
        assert im.height >= 3 * 200 - 6
