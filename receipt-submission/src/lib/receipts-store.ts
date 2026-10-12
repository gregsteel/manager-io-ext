import { mkdirSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export type ReceiptRecord = {
  id: string;
  createdAt: string;
  submittedBy: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  analysisJson: string | null;
  analysedAt: string | null;
  processedAt: string | null;
};

export type ListReceiptsFilter = {
  since?: string;
  until?: string;
  unanalysed?: boolean;
  unprocessed?: boolean;
  limit?: number;
};

type ReceiptRow = {
  id: string;
  created_at: string;
  submitted_by: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  analysis_json: string | null;
  analysed_at: string | null;
  processed_at: string | null;
};

const globalForStore = globalThis as typeof globalThis & {
  receiptsDb?: DatabaseSync;
};

function dataDir(): string {
  const fromEnv = process.env.DATA_DIR?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : path.join(process.cwd(), "data");
}

function filesDir(): string {
  return path.join(dataDir(), "files");
}

function dbPath(): string {
  return path.join(dataDir(), "receipts.db");
}

function imagePath(id: string): string {
  return path.join(filesDir(), `${id}.jpg`);
}

export function getReceiptsDb(): DatabaseSync {
  return openDb();
}

function openDb(): DatabaseSync {
  if (globalForStore.receiptsDb) {
    return globalForStore.receiptsDb;
  }

  mkdirSync(filesDir(), { recursive: true });
  const db = new DatabaseSync(dbPath());
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      submitted_by TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      analysis_json TEXT,
      analysed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS receipts_created_at ON receipts (created_at);
  `);
  const columns = db.prepare("PRAGMA table_info(receipts)").all() as { name: string }[];
  if (!columns.some((col) => col.name === "processed_at")) {
    db.exec("ALTER TABLE receipts ADD COLUMN processed_at TEXT");
  }
  globalForStore.receiptsDb = db;
  return db;
}

function mapRow(row: ReceiptRow): ReceiptRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    submittedBy: row.submitted_by,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    analysisJson: row.analysis_json,
    analysedAt: row.analysed_at,
    processedAt: row.processed_at,
  };
}

export async function saveReceipt(input: {
  bytes: Buffer;
  submittedBy: string;
  filename: string;
  mimeType: string;
}): Promise<ReceiptRecord> {
  const db = openDb();
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const mimeType = input.mimeType || "image/jpeg";
  const record: ReceiptRecord = {
    id,
    createdAt,
    submittedBy: input.submittedBy,
    filename: input.filename,
    mimeType,
    sizeBytes: input.bytes.length,
    analysisJson: null,
    analysedAt: null,
    processedAt: null,
  };

  const dest = imagePath(id);
  await writeFile(dest, input.bytes);

  try {
    db.prepare(
      `INSERT INTO receipts (
        id, created_at, submitted_by, filename, mime_type, size_bytes
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      createdAt,
      input.submittedBy,
      input.filename,
      mimeType,
      input.bytes.length,
    );
  } catch (err) {
    await unlink(dest).catch(() => undefined);
    throw err;
  }

  return record;
}

/** Row with no image file yet (`size_bytes = 0`). Used by MCP `create_receipt`
 * before Cowork PUTs bytes to `/api/receipts/:id/image`. */
export function createReceiptPlaceholder(input: {
  submittedBy: string;
  filename: string;
  mimeType?: string;
}): ReceiptRecord {
  const db = openDb();
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const mimeType = input.mimeType || "image/jpeg";
  db.prepare(
    `INSERT INTO receipts (
      id, created_at, submitted_by, filename, mime_type, size_bytes
    ) VALUES (?, ?, ?, ?, ?, 0)`,
  ).run(id, createdAt, input.submittedBy, input.filename, mimeType);
  return getReceipt(id)!;
}

/**
 * Write the JPEG for a placeholder (or reject if an image already exists).
 * One-shot: does not overwrite an existing file.
 */
export async function attachReceiptImage(
  id: string,
  input: {
    bytes: Buffer;
    mimeType: string;
    filename?: string;
  },
): Promise<ReceiptRecord | null> {
  const existing = getReceipt(id);
  if (!existing) {
    return null;
  }
  if (existing.sizeBytes > 0) {
    throw new Error("Receipt image already uploaded");
  }

  const dest = imagePath(id);
  try {
    await readFile(dest);
    throw new Error("Receipt image already uploaded");
  } catch (err) {
    if (err instanceof Error && err.message === "Receipt image already uploaded") {
      throw err;
    }
    /* ENOENT — expected for placeholders */
  }

  const mimeType = input.mimeType || "image/jpeg";
  const filename = input.filename?.trim() || existing.filename;
  await writeFile(dest, input.bytes);

  try {
    openDb()
      .prepare(
        `UPDATE receipts SET filename = ?, mime_type = ?, size_bytes = ? WHERE id = ?`,
      )
      .run(filename, mimeType, input.bytes.length, id);
  } catch (err) {
    await unlink(dest).catch(() => undefined);
    throw err;
  }

  return getReceipt(id);
}

export function listReceipts(filter: ListReceiptsFilter = {}): ReceiptRecord[] {
  const db = openDb();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.since) {
    clauses.push("created_at >= ?");
    params.push(filter.since);
  }
  if (filter.until) {
    clauses.push("created_at <= ?");
    params.push(filter.until);
  }
  if (filter.unanalysed) {
    clauses.push("analysed_at IS NULL");
  }
  if (filter.unprocessed) {
    clauses.push("processed_at IS NULL");
  }

  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT id, created_at, submitted_by, filename, mime_type, size_bytes,
              analysis_json, analysed_at, processed_at
       FROM receipts ${where}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(...params, limit) as ReceiptRow[];

  return rows.map(mapRow);
}

export function getReceipt(id: string): ReceiptRecord | null {
  const db = openDb();
  const row = db
    .prepare(
      `SELECT id, created_at, submitted_by, filename, mime_type, size_bytes,
              analysis_json, analysed_at, processed_at
       FROM receipts WHERE id = ?`,
    )
    .get(id) as ReceiptRow | undefined;
  return row ? mapRow(row) : null;
}

export async function readReceiptImage(id: string): Promise<Buffer | null> {
  if (!getReceipt(id)) {
    return null;
  }
  try {
    return await readFile(imagePath(id));
  } catch {
    return null;
  }
}

export function markProcessed(id: string): ReceiptRecord | null {
  return setProcessed(id, true);
}

/** Sets or clears `processed_at`. Used by the review UI's manual override;
 * Cowork only ever sets it via `markProcessed`. */
export function setProcessed(id: string, processed: boolean): ReceiptRecord | null {
  if (!getReceipt(id)) {
    return null;
  }
  const processedAt = processed ? new Date().toISOString() : null;
  openDb()
    .prepare("UPDATE receipts SET processed_at = ? WHERE id = ?")
    .run(processedAt, id);
  return getReceipt(id);
}

/** Deletes the row and its JPEG. Caller decides whether an unprocessed
 * guard applies — this function itself has no opinion. */
export async function deleteReceipt(id: string): Promise<boolean> {
  const existing = getReceipt(id);
  if (!existing) {
    return false;
  }
  openDb().prepare("DELETE FROM receipts WHERE id = ?").run(id);
  await unlink(imagePath(id)).catch(() => undefined);
  return true;
}

/** MCP callers occasionally pass `analysis` as an already-JSON-stringified
 * string (observed from Cowork's save_analysis calls) rather than a native
 * object. Blindly `JSON.stringify`-ing that re-encodes it a second time,
 * which then parses back out as a plain string instead of an object on
 * read — so a valid-JSON string is stored as-is, not re-wrapped. */
function normalizeAnalysisJson(analysis: unknown): string {
  if (typeof analysis === "string") {
    try {
      JSON.parse(analysis);
      return analysis;
    } catch {
      /* not JSON text — fall through to a normal stringify below */
    }
  }
  return JSON.stringify(analysis);
}

export function saveAnalysis(id: string, analysis: unknown): ReceiptRecord | null {
  const existing = getReceipt(id);
  if (!existing) {
    return null;
  }

  const analysedAt = new Date().toISOString();
  const analysisJson = normalizeAnalysisJson(analysis);
  openDb()
    .prepare(
      `UPDATE receipts SET analysis_json = ?, analysed_at = ? WHERE id = ?`,
    )
    .run(analysisJson, analysedAt, id);

  return getReceipt(id);
}
