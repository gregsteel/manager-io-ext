/**
 * `analysis_json` is opaque — Cowork can write any shape (see SPEC §6.2). The
 * review page needs *something* consistent to edit, so this file is the one
 * place that guesses at field names on the way in and writes a stable shape
 * (documented in SPEC §9) on the way out. Anything unrecognised in the
 * original object is preserved untouched.
 */

export type ReceiptLineItem = {
  description: string;
  amount: number | null;
  category: string;
};

export type ReceiptAnalysis = {
  vendor: string;
  date: string;
  dueDate: string;
  total: number | null;
  currency: string;
  reference: string;
  notes: string;
  items: ReceiptLineItem[];
};

/** `parseAnalysis`'s return type: the editable fields plus Cowork's own
 * read-only assessment of why a receipt needs a human look. These are never
 * edited or explicitly round-tripped — `mergeAnalysis`'s base-object spread
 * preserves them on save regardless. */
export type ParsedReceiptAnalysis = ReceiptAnalysis & {
  confidence: string;
  confidenceReason: string;
};

/**
 * True only when Cowork marked the receipt as requiring a human look
 * (`confidence: "review"`). A non-empty `confidenceReason` alone is not
 * enough — Cowork often writes explanatory notes there on `"auto"` receipts
 * too (FX matching, surcharge arithmetic, etc.).
 */
export function needsHumanReview(analysis: ParsedReceiptAnalysis): boolean {
  return analysis.confidence.trim().toLowerCase() === "review";
}

const VENDOR_KEYS = ["vendor", "merchant", "store", "supplier"];
const DATE_KEYS = ["date", "purchaseDate", "transactionDate", "receiptDate"];
const DUE_DATE_KEYS = ["dueDate", "due_date", "paymentDueDate", "dueBy"];
const TOTAL_KEYS = ["total", "grandTotal", "amount", "amountTotal"];
const CURRENCY_KEYS = ["currency", "currencyCode"];
const REFERENCE_KEYS = [
  "reference",
  "referenceNumber",
  "invoiceNumber",
  "receiptNumber",
  "receiptNo",
];
const NOTES_KEYS = ["notes", "note", "comment", "comments"];
const CONFIDENCE_KEYS = ["confidence"];
const CONFIDENCE_REASON_KEYS = ["confidenceReason", "confidence_reason", "reviewReason"];
const ITEMS_KEYS = ["items", "lineItems", "line_items", "lines"];
const ITEM_DESC_KEYS = ["description", "desc", "name", "item", "label"];
const ITEM_AMOUNT_KEYS = ["amount", "cost", "price", "total", "value"];
const ITEM_CATEGORY_KEYS = ["category", "tag", "type", "class"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    // A receipt/invoice number that looks numeric (e.g. "0020012364141") is
    // invalid JSON as a bare number literal — leading zeros aren't allowed —
    // so a model treating it as numeric emits the zeros-stripped number
    // instead. Coerce rather than lose it.
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function firstNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const n = Number(value.replace(/[^0-9.-]/g, ""));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/**
 * Parses `analysis_json`, unwrapping an extra layer of JSON-encoding if it
 * was accidentally double-encoded — a JSON string passed as the `analysis`
 * MCP argument (observed from Cowork) previously got re-stringified on save,
 * so `JSON.parse` yields a string instead of an object. `saveAnalysis` no
 * longer does that going forward, but already-corrupted rows can still have
 * this shape, so unwrap defensively here rather than only fixing new writes.
 */
function parseStoredJson(raw: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  for (let i = 0; i < 3 && typeof value === "string"; i++) {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }
  return value;
}

function parseItem(value: unknown): ReceiptLineItem | null {
  if (!isPlainObject(value)) return null;
  const description = firstString(value, ITEM_DESC_KEYS);
  const amount = firstNumber(value, ITEM_AMOUNT_KEYS);
  const category = firstString(value, ITEM_CATEGORY_KEYS);
  if (!description && amount === null && !category) return null;
  return { description, amount, category };
}

/** Best-effort read of whatever Cowork last saved into `analysis_json`. */
export function parseAnalysis(raw: string | null): ParsedReceiptAnalysis {
  const empty: ParsedReceiptAnalysis = {
    vendor: "",
    date: "",
    dueDate: "",
    total: null,
    currency: "",
    reference: "",
    notes: "",
    items: [],
    confidence: "",
    confidenceReason: "",
  };
  if (!raw) return empty;

  const obj = parseStoredJson(raw);
  if (!isPlainObject(obj)) return empty;

  const vendor = firstString(obj, VENDOR_KEYS);
  const date = firstString(obj, DATE_KEYS);
  const dueDate = firstString(obj, DUE_DATE_KEYS);
  const total = firstNumber(obj, TOTAL_KEYS);
  const currency = firstString(obj, CURRENCY_KEYS);
  const confidence = firstString(obj, CONFIDENCE_KEYS);
  const confidenceReason = firstString(obj, CONFIDENCE_REASON_KEYS);
  const reference = firstString(obj, REFERENCE_KEYS);
  const notes = firstString(obj, NOTES_KEYS);

  let items: ReceiptLineItem[] = [];
  for (const key of ITEMS_KEYS) {
    const value = obj[key];
    if (Array.isArray(value)) {
      items = value.map(parseItem).filter((item): item is ReceiptLineItem => item !== null);
      if (items.length > 0) break;
    }
  }

  // Nothing to split — seed one row from the total so there's something to
  // edit instead of a blank table.
  if (items.length === 0 && total !== null) {
    items = [{ description: vendor || "Total", amount: total, category: "" }];
  }

  return {
    vendor,
    date,
    dueDate,
    total,
    currency,
    reference,
    notes,
    items,
    confidence,
    confidenceReason,
  };
}

/**
 * Merges edited fields back over whatever Cowork originally saved, so keys
 * this page doesn't know about (confidence scores, raw OCR text, etc.)
 * survive a review-and-save round trip.
 */
export function mergeAnalysis(
  original: string | null,
  edits: ReceiptAnalysis & { reviewedBy: string; reviewedAt: string },
): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  if (original) {
    const parsed = parseStoredJson(original);
    if (isPlainObject(parsed)) base = parsed;
  }
  return {
    ...base,
    vendor: edits.vendor,
    date: edits.date,
    dueDate: edits.dueDate,
    total: edits.total,
    currency: edits.currency,
    reference: edits.reference,
    notes: edits.notes,
    items: edits.items,
    reviewedBy: edits.reviewedBy,
    reviewedAt: edits.reviewedAt,
  };
}
