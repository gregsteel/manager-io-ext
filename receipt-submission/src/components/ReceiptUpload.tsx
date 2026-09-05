"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB, mirrors /api/send

type QueueItem = {
  key: string;
  file: File;
  status: "pending" | "uploading" | "done" | "error";
  receiptId?: string;
  error?: string;
};

let keySeq = 0;
function newKey(): string {
  keySeq += 1;
  return `upload-${keySeq}`;
}

async function uploadOne(file: File): Promise<{ id: string }> {
  const formData = new FormData();
  formData.append("receipt", file);
  if (file.lastModified) {
    formData.append("capturedAt", new Date(file.lastModified).toISOString());
  }
  const res = await fetch("/api/send", { method: "POST", body: formData });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Upload failed (${res.status})`);
  }
  return body;
}

export function ReceiptUpload() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const enqueue = useCallback((files: FileList | File[]) => {
    const accepted = Array.from(files).filter((f) => {
      const isPdf =
        f.type === "application/pdf" ||
        (!f.type && f.name.toLowerCase().endsWith(".pdf"));
      if (!isPdf && f.type && !f.type.startsWith("image/")) return false;
      if (f.size === 0 || f.size > MAX_BYTES) return false;
      return true;
    });
    if (accepted.length === 0) return;

    const queued: QueueItem[] = accepted.map((file) => ({
      key: newKey(),
      file,
      status: "pending",
    }));
    setItems((prev) => [...queued, ...prev]);

    for (const queuedItem of queued) {
      setItems((prev) =>
        prev.map((it) => (it.key === queuedItem.key ? { ...it, status: "uploading" } : it)),
      );
      uploadOne(queuedItem.file)
        .then(({ id }) => {
          setItems((prev) =>
            prev.map((it) =>
              it.key === queuedItem.key ? { ...it, status: "done", receiptId: id } : it,
            ),
          );
        })
        .catch((err: unknown) => {
          setItems((prev) =>
            prev.map((it) =>
              it.key === queuedItem.key
                ? {
                    ...it,
                    status: "error",
                    error: err instanceof Error ? err.message : "Upload failed",
                  }
                : it,
            ),
          );
        });
    }
  }, []);

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) {
      enqueue(e.dataTransfer.files);
    }
  }

  function handleSelect(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      enqueue(e.target.files);
    }
    e.target.value = "";
  }

  return (
    <div className="mx-auto min-h-dvh max-w-2xl px-5 pb-16">
      <header
        className="pb-4"
        style={{ paddingTop: "max(1.25rem, var(--safe-top))" }}
      >
        <Link
          href="/receipts"
          className="text-sm font-medium tracking-wide text-muted uppercase hover:text-foreground"
        >
          ← Receipts
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
          Upload receipts
        </h1>
        <p className="mt-1 text-sm text-muted">
          Drop image or PDF files here, or choose them from your computer.
          A PDF&apos;s first page is converted to an image automatically.
        </p>
      </header>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        className={`flex min-h-48 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-5 py-10 text-center transition-colors ${
          dragging
            ? "border-accent bg-accent-soft"
            : "border-black/15 bg-surface hover:border-accent/40"
        }`}
      >
        <p className="text-base font-medium text-foreground">
          Drag receipts here
        </p>
        <p className="text-sm text-muted">or click to browse</p>
        <input
          ref={inputRef}
          type="file"
          accept="image/*,application/pdf"
          multiple
          onChange={handleSelect}
          className="hidden"
        />
      </div>

      {items.length > 0 ? (
        <ul className="mt-6 space-y-2">
          {items.map((item) => (
            <li
              key={item.key}
              className="flex items-center gap-3 rounded-xl border border-black/10 bg-surface p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">
                  {item.file.name}
                </p>
                {item.status === "error" ? (
                  <p className="mt-0.5 truncate text-xs text-danger">{item.error}</p>
                ) : null}
              </div>
              {item.status === "uploading" || item.status === "pending" ? (
                <span className="shrink-0 text-xs text-muted">Uploading…</span>
              ) : null}
              {item.status === "error" ? (
                <span className="shrink-0 text-xs font-medium text-danger">Failed</span>
              ) : null}
              {item.status === "done" && item.receiptId ? (
                <Link
                  href={`/review/${item.receiptId}`}
                  className="shrink-0 text-xs font-medium text-accent underline-offset-2 hover:underline"
                >
                  Review
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
