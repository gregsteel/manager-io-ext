"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  needsHumanReview,
  type ParsedReceiptAnalysis,
  type ReceiptLineItem,
} from "@/lib/analysis";

type ReceiptSummary = {
  id: string;
  createdAt: string;
  filename: string;
  processedAt: string | null;
  hasAnalysis: boolean;
};

type Row = ReceiptLineItem & { key: string };

let rowSeq = 0;
function newRow(item?: ReceiptLineItem): Row {
  rowSeq += 1;
  return {
    key: `row-${rowSeq}`,
    description: item?.description ?? "",
    amount: item?.amount ?? null,
    category: item?.category ?? "",
  };
}

export function ReceiptReview({
  receipt,
  analysis,
}: {
  receipt: ReceiptSummary;
  analysis: ParsedReceiptAnalysis;
}) {
  const [vendor, setVendor] = useState(analysis.vendor);
  const [date, setDate] = useState(analysis.date);
  const [dueDate, setDueDate] = useState(analysis.dueDate);
  const [total, setTotal] = useState(analysis.total ?? "");
  const [currency, setCurrency] = useState(analysis.currency);
  const [reference, setReference] = useState(analysis.reference);
  const [notes, setNotes] = useState(analysis.notes);
  const [rows, setRows] = useState<Row[]>(() =>
    analysis.items.length > 0 ? analysis.items.map(newRow) : [newRow()],
  );
  const [status, setStatus] = useState<
    { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [imageOpen, setImageOpen] = useState(false);
  const [processedAt, setProcessedAt] = useState(receipt.processedAt);
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const router = useRouter();

  const itemsTotal = useMemo(
    () => rows.reduce((sum, row) => sum + (typeof row.amount === "number" ? row.amount : 0), 0),
    [rows],
  );
  const declaredTotal = typeof total === "number" ? total : Number(total);
  const totalMismatch =
    Number.isFinite(declaredTotal) &&
    total !== "" &&
    Math.abs(itemsTotal - declaredTotal) > 0.01;

  function updateRow(key: string, patch: Partial<ReceiptLineItem>) {
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function removeRow(key: string) {
    setRows((prev) => (prev.length > 1 ? prev.filter((row) => row.key !== key) : prev));
  }

  function addRow() {
    setRows((prev) => [...prev, newRow()]);
  }

  async function handleToggleProcessed() {
    setStatusUpdating(true);
    try {
      const res = await fetch(`/api/receipts/${receipt.id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ processed: !processedAt }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Update failed (${res.status})`);
      }
      const { receipt: updated } = await res.json();
      setProcessedAt(updated.processedAt);
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Update failed",
      });
    } finally {
      setStatusUpdating(false);
    }
  }

  async function handleDelete() {
    if (
      !window.confirm(
        "Delete this receipt permanently? This removes the image and analysis and can't be undone.",
      )
    ) {
      return;
    }
    setDeleting(true);
    try {
      const res = await fetch(`/api/receipts/${receipt.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Delete failed (${res.status})`);
      }
      router.push("/receipts");
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Delete failed",
      });
      setDeleting(false);
    }
  }

  async function handleSave() {
    setStatus({ kind: "saving" });
    try {
      const res = await fetch(`/api/receipts/${receipt.id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendor,
          date,
          dueDate,
          total: total === "" ? null : Number(total),
          currency,
          reference,
          notes,
          items: rows.map(({ description, amount, category }) => ({
            description,
            amount,
            category,
          })),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Save failed (${res.status})`);
      }
      setStatus({ kind: "saved" });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Save failed",
      });
    }
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
          Review receipt
        </h1>
        <p className="mt-1 text-sm text-muted">
          {receipt.filename} · {new Date(receipt.createdAt).toLocaleString()}
        </p>
        {!receipt.hasAnalysis ? (
          <p className="mt-3 rounded-lg bg-black/5 px-3 py-2 text-sm text-muted">
            No analysis saved for this receipt yet — the fields below are
            blank, not extracted data. Cowork hasn&apos;t processed it, or a
            save failed.
          </p>
        ) : null}
        {needsHumanReview(analysis) && analysis.confidenceReason ? (
          <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
            <span className="font-medium">Why this needs review:</span>{" "}
            {analysis.confidenceReason}
          </p>
        ) : null}
        {processedAt ? (
          <p className="mt-3 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent-pressed">
            Marked processed on {new Date(processedAt).toLocaleString()}.
            Saving edits the split but won&apos;t re-trigger Cowork.
          </p>
        ) : null}

        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={handleToggleProcessed}
            disabled={statusUpdating}
            className="rounded-lg border border-black/10 bg-surface px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:border-accent/40 disabled:opacity-60"
          >
            {statusUpdating
              ? "Updating…"
              : processedAt
                ? "Mark unprocessed"
                : "Mark processed"}
          </button>
          <a
            href={`/api/receipts/${receipt.id}/image`}
            download={receipt.filename}
            className="text-sm text-accent underline-offset-2 hover:underline"
          >
            Download image
          </a>
          {!processedAt ? (
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="ml-auto text-sm text-danger underline-offset-2 hover:underline disabled:opacity-60"
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
          ) : null}
        </div>
      </header>

      <button
        type="button"
        onClick={() => setImageOpen(true)}
        className="block w-full overflow-hidden rounded-xl border border-black/10 bg-surface"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/receipts/${receipt.id}/image`}
          alt="Receipt"
          className="max-h-80 w-full object-contain"
        />
      </button>

      <section className="mt-6 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Vendor</span>
            <input
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              className="rounded-lg border border-black/10 bg-surface px-3 py-2 text-foreground"
              placeholder="Vendor name"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Date</span>
            <input
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="rounded-lg border border-black/10 bg-surface px-3 py-2 text-foreground"
              placeholder="YYYY-MM-DD"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Due date</span>
            <input
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="rounded-lg border border-black/10 bg-surface px-3 py-2 text-foreground"
              placeholder="YYYY-MM-DD"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Total</span>
            <input
              type="number"
              step="0.01"
              value={total}
              onChange={(e) =>
                setTotal(e.target.value === "" ? "" : Number(e.target.value))
              }
              className="rounded-lg border border-black/10 bg-surface px-3 py-2 text-foreground"
              placeholder="0.00"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Currency</span>
            <input
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="rounded-lg border border-black/10 bg-surface px-3 py-2 text-foreground"
              placeholder="e.g. AUD"
            />
          </label>
          <label className="col-span-2 flex flex-col gap-1 text-sm">
            <span className="text-muted">Reference</span>
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              className="rounded-lg border border-black/10 bg-surface px-3 py-2 text-foreground"
              placeholder="Invoice / receipt number printed on the receipt"
            />
          </label>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-foreground">
              Items
            </span>
            <button
              type="button"
              onClick={addRow}
              className="text-sm text-accent underline-offset-2 hover:underline"
            >
              + Add item
            </button>
          </div>

          <div className="mt-2 space-y-2">
            {rows.map((row) => (
              <div key={row.key} className="flex items-center gap-2">
                <input
                  value={row.description}
                  onChange={(e) =>
                    updateRow(row.key, { description: e.target.value })
                  }
                  placeholder="Description"
                  className="min-w-0 flex-1 rounded-lg border border-black/10 bg-surface px-3 py-2 text-sm text-foreground"
                />
                <input
                  type="number"
                  step="0.01"
                  value={row.amount ?? ""}
                  onChange={(e) =>
                    updateRow(row.key, {
                      amount: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                  placeholder="0.00"
                  className="w-24 shrink-0 rounded-lg border border-black/10 bg-surface px-3 py-2 text-sm text-foreground"
                />
                <button
                  type="button"
                  onClick={() => removeRow(row.key)}
                  disabled={rows.length === 1}
                  className="shrink-0 px-1 text-muted transition-colors hover:text-danger disabled:opacity-30"
                  aria-label="Remove item"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          <p
            className={`mt-2 text-right text-sm ${totalMismatch ? "text-danger" : "text-muted"}`}
          >
            Items total: {itemsTotal.toFixed(2)}
            {totalMismatch ? ` — doesn't match receipt total (${declaredTotal.toFixed(2)})` : ""}
          </p>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Notes</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="resize-none rounded-lg border border-black/10 bg-surface px-3 py-2 text-foreground"
          />
        </label>

        <button
          type="button"
          onClick={handleSave}
          disabled={status.kind === "saving"}
          className="flex h-12 w-full items-center justify-center rounded-xl bg-accent text-base font-semibold text-surface transition-colors active:bg-accent-pressed disabled:opacity-60"
        >
          {status.kind === "saving" ? "Saving…" : "Save"}
        </button>

        {status.kind === "saved" ? (
          <p className="text-center text-sm text-success">
            Saved. Cowork will pick this up next run.
          </p>
        ) : null}
        {status.kind === "error" ? (
          <p className="text-center text-sm text-danger">{status.message}</p>
        ) : null}
      </section>

      {imageOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setImageOpen(false)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/receipts/${receipt.id}/image`}
            alt="Receipt full size"
            className="max-h-full max-w-full object-contain"
          />
        </div>
      ) : null}
    </div>
  );
}
