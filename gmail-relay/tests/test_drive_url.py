import pytest

from gmail_relay.drive_url import DriveUrlError, parse_drive_file_id

FILE_ID = "1aBcDeFgHiJkLmNoPqRsTuVwXyZ012345"


@pytest.mark.parametrize(
    "raw",
    [
        FILE_ID,
        f"https://drive.google.com/file/d/{FILE_ID}/view",
        f"https://drive.google.com/file/d/{FILE_ID}/view?usp=sharing",
        f"https://drive.google.com/open?id={FILE_ID}",
        f"https://drive.google.com/uc?id={FILE_ID}&export=download",
        f"https://docs.google.com/document/d/{FILE_ID}/edit",
        f"https://docs.google.com/spreadsheets/d/{FILE_ID}/edit#gid=0",
        f"https://docs.google.com/presentation/d/{FILE_ID}/edit",
        f"https://docs.google.com/drawings/d/{FILE_ID}/edit",
        f"  https://drive.google.com/file/d/{FILE_ID}/view  ",
    ],
)
def test_parse_drive_file_id_accepts_known_shapes(raw: str) -> None:
    assert parse_drive_file_id(raw) == FILE_ID


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "   ",
        "not-a-link",
        "https://example.com/file/d/abc/view",
        f"https://drive.google.com/drive/folders/{FILE_ID}",
        f"https://drive.google.com/drive/u/0/folders/{FILE_ID}",
        "https://drive.google.com/drive/my-drive",
    ],
)
def test_parse_drive_file_id_rejects_unusable(raw: str) -> None:
    with pytest.raises(DriveUrlError):
        parse_drive_file_id(raw)
