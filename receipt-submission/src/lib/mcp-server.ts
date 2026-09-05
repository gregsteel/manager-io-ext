import { appOrigin } from "@/lib/app-origin";
import {
  createImageAccessToken,
  createImageUploadToken,
} from "@/lib/auth/image-token";
import {
  decodeReceiptImageBase64,
  fetchReceiptImageFromUrl,
  RECEIPT_IMAGE_MAX_BYTES,
} from "@/lib/fetch-receipt-image";
import {
  createReceiptPlaceholder,
  getReceipt,
  listReceipts,
  markProcessed,
  readReceiptImage,
  saveAnalysis,
  saveReceipt,
} from "@/lib/receipts-store";

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type McpCaller = {
  email: string;
};

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "receipts", version: "0.1.0" };

const TOOLS = [
  {
    name: "list_receipts",
    description:
      "List stored receipts (newest first). Use unanalysed=true to find receipts that still need review.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description: "ISO-8601 lower bound on createdAt (inclusive)",
        },
        until: {
          type: "string",
          description: "ISO-8601 upper bound on createdAt (inclusive)",
        },
        unanalysed: {
          type: "boolean",
          description: "If true, only receipts with no saved analysis",
        },
        unprocessed: {
          type: "boolean",
          description: "If true, only receipts not yet marked processed",
        },
        limit: {
          type: "integer",
          description: "Max rows (1–200, default 50)",
        },
      },
    },
  },
  {
    name: "get_receipt",
    description:
      "Fetch one receipt’s metadata and JPEG image for analysis.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Receipt id from list_receipts" },
      },
    },
  },
  {
    name: "create_receipt",
    description:
      "Create a receipt row without an image, then upload bytes with HTTP. Returns uploadToken (Bearer) and uploadUrl for a PUT/POST of the file (e.g. curl). Prefer this when Cowork has a local file path. Token expires in 30 minutes. PDFs are not supported on upload.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "Optional filename; defaults to receipt_<stamp>.jpg",
        },
        mimeType: {
          type: "string",
          description: "Expected MIME type (default image/jpeg)",
        },
        capturedAt: {
          type: "string",
          description:
            "Optional ISO-8601 local capture time used in the default filename",
        },
      },
    },
    annotations: {
      title: "Create receipt",
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "save_receipt",
    description:
      "Store a new receipt image from an HTTPS URL the server fetches, or from base64 bytes. Local filesystem paths are not supported (remote MCP cannot see Cowork's disk). Provide exactly one of imageUrl or imageBase64. PDFs are not supported. For local files, prefer create_receipt + HTTP upload.",
    inputSchema: {
      type: "object",
      properties: {
        imageUrl: {
          type: "string",
          description:
            "HTTPS URL of an image the server will fetch and store (SSRF-limited, max 8 MB)",
        },
        imageBase64: {
          type: "string",
          description:
            "Base64-encoded image bytes when no durable HTTPS URL remains after download",
        },
        mimeType: {
          type: "string",
          description:
            "MIME type when using imageBase64 (e.g. image/jpeg). Defaults to image/jpeg.",
        },
        filename: {
          type: "string",
          description: "Optional filename; defaults to receipt_<stamp>.jpg",
        },
        capturedAt: {
          type: "string",
          description:
            "Optional ISO-8601 local capture time used in the default filename",
        },
      },
    },
    annotations: {
      title: "Save receipt",
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "save_analysis",
    description:
      "Persist analysis for a receipt (vendor, date, dueDate, totals, tax, notes, etc.). Include dueDate (ISO-8601, e.g. from payment terms printed on the receipt/invoice) whenever it's available so it can carry through to the accounting system.",
    inputSchema: {
      type: "object",
      required: ["id", "analysis"],
      properties: {
        id: { type: "string" },
        analysis: {
          description:
            "JSON object with extracted fields, e.g. { vendor, date, dueDate, total, currency, reference, notes, items }",
        },
      },
    },
  },
  {
    name: "mark_processed",
    description:
      "Mark a receipt as processed once it has been recorded downstream (e.g. in your accounting system). Does not delete anything.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Receipt id from list_receipts" },
      },
    },
    annotations: {
      title: "Mark receipt processed",
      destructiveHint: false,
      idempotentHint: true,
    },
  },
];

function rpcResult(id: JsonRpcId | undefined, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(
  id: JsonRpcId | undefined,
  code: number,
  message: string,
) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function asLimit(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function defaultReceiptFilename(capturedAt: unknown): string {
  const parts =
    typeof capturedAt === "string"
      ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(capturedAt)
      : null;
  const stamp = parts
    ? `${parts[1]}-${parts[2]}-${parts[3]}_${parts[4]}-${parts[5]}-${parts[6]}`
    : new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .slice(0, 19);
  return `receipt_${stamp}.jpg`;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  caller: McpCaller,
): Promise<{ content: ToolContent[]; isError?: boolean }> {
  if (name === "list_receipts") {
    const rows = listReceipts({
      since: typeof args.since === "string" ? args.since : undefined,
      until: typeof args.until === "string" ? args.until : undefined,
      unanalysed: asBool(args.unanalysed),
      unprocessed: asBool(args.unprocessed),
      limit: asLimit(args.limit),
    });
    return {
      content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
    };
  }

  if (name === "get_receipt") {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!id) {
      return {
        isError: true,
        content: [{ type: "text", text: "id is required" }],
      };
    }
    const receipt = getReceipt(id);
    if (!receipt) {
      return {
        isError: true,
        content: [{ type: "text", text: `Receipt not found: ${id}` }],
      };
    }
    const bytes = await readReceiptImage(id);
    if (!bytes) {
      return {
        isError: true,
        content: [{ type: "text", text: `Image missing for receipt ${id}` }],
      };
    }
    // Cowork can view the image content block below but can't read its
    // base64 back out as text to hand to another MCP server (e.g.
    // manager-mcp's attach_receipt_to_purchase_invoice), and has no
    // filesystem to stage a file on either. imageUrl is a signed,
    // unauthenticated, 10-minute link any such server can just GET —
    // see docs/SIGNED_IMAGE_URL.md. Additive: the image content block
    // stays for Cowork's own analysis step.
    const imageToken = await createImageAccessToken(id);
    const imageUrl = `${appOrigin()}/api/receipts/${id}/image?token=${imageToken}`;
    const content: ToolContent[] = [
      { type: "text", text: JSON.stringify({ ...receipt, imageUrl }, null, 2) },
      {
        type: "image",
        data: bytes.toString("base64"),
        mimeType: receipt.mimeType,
      },
    ];
    return { content };
  }

  if (name === "create_receipt") {
    const filename =
      typeof args.filename === "string" && args.filename.trim()
        ? args.filename.trim()
        : defaultReceiptFilename(args.capturedAt);
    const mimeType =
      typeof args.mimeType === "string" && args.mimeType.trim()
        ? args.mimeType.trim()
        : "image/jpeg";
    const receipt = createReceiptPlaceholder({
      submittedBy: caller.email,
      filename,
      mimeType,
    });
    const uploadToken = await createImageUploadToken(receipt.id);
    const uploadUrl = `${appOrigin()}/api/receipts/${receipt.id}/image`;
    const curlExample = `curl -X PUT -H "Authorization: Bearer ${uploadToken}" -H "Content-Type: ${mimeType}" --data-binary @"/path/to/receipt.jpg" "${uploadUrl}"`;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ...receipt,
              uploadToken,
              uploadUrl,
              uploadTokenExpiresIn: "30m",
              curlExample,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (name === "save_receipt") {
    const imageUrl =
      typeof args.imageUrl === "string" ? args.imageUrl.trim() : "";
    const imageBase64 =
      typeof args.imageBase64 === "string" ? args.imageBase64.trim() : "";
    const hasUrl = imageUrl.length > 0;
    const hasBase64 = imageBase64.length > 0;
    if (hasUrl === hasBase64) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Provide exactly one of imageUrl or imageBase64 (local paths are not supported)",
          },
        ],
      };
    }

    let bytes: Buffer;
    let mimeType: string;
    try {
      if (hasUrl) {
        const fetched = await fetchReceiptImageFromUrl(imageUrl);
        bytes = fetched.bytes;
        mimeType = fetched.mimeType;
      } else {
        const mimeArg =
          typeof args.mimeType === "string" && args.mimeType.trim()
            ? args.mimeType.trim()
            : "image/jpeg";
        const decoded = decodeReceiptImageBase64(imageBase64, mimeArg);
        bytes = decoded.bytes;
        mimeType = decoded.mimeType;
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : "Failed to read image";
      return {
        isError: true,
        content: [{ type: "text", text }],
      };
    }

    if (bytes.length > RECEIPT_IMAGE_MAX_BYTES) {
      return {
        isError: true,
        content: [{ type: "text", text: "Image is too large (max 8 MB)" }],
      };
    }

    const filename =
      typeof args.filename === "string" && args.filename.trim()
        ? args.filename.trim()
        : defaultReceiptFilename(args.capturedAt);

    const saved = await saveReceipt({
      bytes,
      submittedBy: caller.email,
      filename,
      mimeType,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(saved, null, 2) }],
    };
  }

  if (name === "save_analysis") {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!id) {
      return {
        isError: true,
        content: [{ type: "text", text: "id is required" }],
      };
    }
    if (args.analysis === undefined) {
      return {
        isError: true,
        content: [{ type: "text", text: "analysis is required" }],
      };
    }
    const updated = saveAnalysis(id, args.analysis);
    if (!updated) {
      return {
        isError: true,
        content: [{ type: "text", text: `Receipt not found: ${id}` }],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(updated, null, 2) }],
    };
  }

  if (name === "mark_processed") {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!id) {
      return {
        isError: true,
        content: [{ type: "text", text: "id is required" }],
      };
    }
    const updated = markProcessed(id);
    if (!updated) {
      return {
        isError: true,
        content: [{ type: "text", text: `Receipt not found: ${id}` }],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(updated, null, 2) }],
    };
  }

  return {
    isError: true,
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
  };
}

async function handleMessage(message: JsonRpcRequest, caller: McpCaller) {
  const method = message.method ?? "";
  const id = message.id;
  const isNotification = id === undefined;

  if (method === "notifications/initialized" || method.startsWith("notifications/")) {
    return isNotification ? null : rpcResult(id, {});
  }

  if (method === "ping") {
    return rpcResult(id, {});
  }

  if (method === "initialize") {
    const requested =
      typeof message.params?.protocolVersion === "string"
        ? message.params.protocolVersion
        : PROTOCOL_VERSION;
    return rpcResult(id, {
      protocolVersion: requested || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }

  if (method === "tools/list") {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const name =
      typeof message.params?.name === "string" ? message.params.name : "";
    const args =
      message.params?.arguments &&
      typeof message.params.arguments === "object" &&
      !Array.isArray(message.params.arguments)
        ? (message.params.arguments as Record<string, unknown>)
        : {};
    try {
      const result = await callTool(name, args, caller);
      return rpcResult(id, result);
    } catch (err) {
      const text = err instanceof Error ? err.message : "Tool failed";
      return rpcResult(id, {
        isError: true,
        content: [{ type: "text", text }],
      });
    }
  }

  if (isNotification) {
    return null;
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

export async function handleMcpBody(
  body: unknown,
  caller: McpCaller,
): Promise<{
  status: number;
  payload: unknown | null;
}> {
  if (Array.isArray(body)) {
    const results = [];
    for (const item of body) {
      const handled = await handleMessage(item as JsonRpcRequest, caller);
      if (handled) results.push(handled);
    }
    if (results.length === 0) {
      return { status: 202, payload: null };
    }
    return { status: 200, payload: results };
  }

  if (!body || typeof body !== "object") {
    return {
      status: 200,
      payload: rpcError(null, -32600, "Invalid request"),
    };
  }

  const handled = await handleMessage(body as JsonRpcRequest, caller);
  if (!handled) {
    return { status: 202, payload: null };
  }
  return { status: 200, payload: handled };
}
