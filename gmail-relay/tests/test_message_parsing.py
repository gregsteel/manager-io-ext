from gmail_relay.message_parsing import find_attachment_mime_type, summarize_message

FULL_MESSAGE = {
    "id": "19fd0ae3ff9f8612",
    "threadId": "19fd0ae3ff9f8612",
    "labelIds": ["UNREAD", "Label_14"],
    "payload": {
        "headers": [
            {"name": "Subject", "value": "Your AAMI renewal is due"},
            {"name": "From", "value": "AAMI <noreply@aami.com.au>"},
            {"name": "Date", "value": "Mon, 20 Aug 2026 03:14:00 +0000"},
        ],
        "parts": [
            {"mimeType": "text/plain", "body": {}},
            {
                "mimeType": "application/pdf",
                "filename": "invoice.pdf",
                "body": {"attachmentId": "ANGjdJ...", "size": 84213},
            },
        ],
    },
}


def test_summarize_message_extracts_headers_and_attachments():
    summary = summarize_message(FULL_MESSAGE)
    assert summary["id"] == "19fd0ae3ff9f8612"
    assert summary["subject"] == "Your AAMI renewal is due"
    assert summary["from"] == "AAMI <noreply@aami.com.au>"
    assert summary["labelIds"] == ["UNREAD", "Label_14"]
    assert summary["attachments"] == [
        {
            "attachmentId": "ANGjdJ...",
            "filename": "invoice.pdf",
            "mimeType": "application/pdf",
            "size": 84213,
        }
    ]


def test_summarize_message_ignores_parts_without_attachment_id():
    message = {
        "id": "x",
        "payload": {"headers": [], "parts": [{"mimeType": "text/plain", "body": {}}]},
    }
    assert summarize_message(message)["attachments"] == []


def test_find_attachment_mime_type_matches_by_id():
    assert find_attachment_mime_type(FULL_MESSAGE, "ANGjdJ...") == "application/pdf"


def test_find_attachment_mime_type_returns_none_when_missing():
    assert find_attachment_mime_type(FULL_MESSAGE, "does-not-exist") is None
