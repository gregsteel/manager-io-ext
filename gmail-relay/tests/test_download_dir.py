from gmail_relay.download_dir import JailedTempFile


def test_named_paths_stay_inside_jail_dir(tmp_path):
    jail_dir = tmp_path / "jail"
    jail = JailedTempFile(jail_dir)
    pdf_path = jail.named(".pdf")
    jpeg_path = jail.named(".jpg")
    assert pdf_path.parent == jail_dir.resolve()
    assert jpeg_path.parent == jail_dir.resolve()
    assert pdf_path.stem == jpeg_path.stem  # same random stem, different suffix


def test_cleanup_removes_only_this_instances_files(tmp_path):
    jail_dir = tmp_path / "jail"
    jail_dir.mkdir()
    other = jail_dir / "unrelated.txt"
    other.write_text("keep me")

    jail = JailedTempFile(jail_dir)
    jail.named(".bin").write_bytes(b"data")
    jail.named(".jpg").write_bytes(b"data")
    jail.cleanup()

    remaining = list(jail_dir.iterdir())
    assert remaining == [other]


def test_two_instances_get_different_stems(tmp_path):
    jail_dir = tmp_path / "jail"
    first = JailedTempFile(jail_dir)
    second = JailedTempFile(jail_dir)
    assert first.named("").name != second.named("").name
