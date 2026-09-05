# Signed image URL for `get_receipt`

**Status: implemented.** Sections 1–3 below shipped as designed. Two things
diverged from the plan, noted inline where relevant: §3 didn't need the
request-threading it anticipated, and there's a §5 the original plan missed
entirely — a real bug that shipped and blocked the feature in production
until it was found and fixed. `docs/SPEC.md` §3.3/§3.4/§7/§8 is the
authoritative current description; this file is the design record.

## Problem

`get_receipt` returns the receipt JPEG only as an MCP `image` content block
(base64 in `content[1].data`). Claude Cowork can *view* that block but has no
way to read its raw base64 back out as text, so it can't hand the bytes on to
another MCP server's tool (e.g. `manager-mcp`'s
`attach_receipt_to_purchase_invoice`). Cowork has no local filesystem to
stage the file to either — it runs sandboxed.

Returning the base64 string as a *text* field instead was considered and
rejected: images run up to ~700KB (`README.md` capture pipeline), so base64
text would burn ~900KB of context per receipt just to relay bytes the model
never needs to read as text — wasteful in a batch job over many receipts.

## Fix

Give `get_receipt` a pre-signed, time-limited, **unauthenticated** URL to the
image alongside the existing JSON + image content. Any caller holding that
URL — including a completely unrelated MCP server with no knowledge of this
app's auth model — can `GET` the raw bytes directly with no headers. This
keeps `manager-mcp` generic: it just fetches whatever URL it's handed.

## 1. Signed token

New file `src/lib/auth/image-token.ts`, following the exact `purpose`-tagged
JWT pattern already used for `createOAuthState`/`verifyOAuthState` in
`src/lib/auth/session-token.ts` — same signing key (`SESSION_SECRET`), same
`jose` library, no new secret or server-side state.

```ts
import { SignJWT, jwtVerify } from "jose";

const IMAGE_TOKEN_TTL = "10m";

function getSecretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret) {
    throw new Error("Missing required environment variable: SESSION_SECRET");
  }
  return new TextEncoder().encode(secret);
}

export async function createImageAccessToken(receiptId: string): Promise<string> {
  return new SignJWT({ purpose: "image-access", receiptId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(IMAGE_TOKEN_TTL)
    .sign(getSecretKey());
}

export async function verifyImageAccessToken(
  token: string | null,
  receiptId: string,
): Promise<boolean> {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, getSecretKey(), {
      algorithms: ["HS256"],
    });
    return payload.purpose === "image-access" && payload.receiptId === receiptId;
  } catch {
    return false;
  }
}
```

10 minutes is enough for `manager-mcp` to fetch the URL right after Cowork
calls `attach_receipt_to_purchase_invoice` with it, without leaving a
long-lived unauthenticated link to a receipt sitting around in a scheduled
task's transcript.

## 2. Image route accepts the token as an alternative to session auth

Edit `src/app/api/receipts/[id]/image/route.ts`. Currently:

```ts
const session = await getSession(request);
if (!session) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
```

Change to accept **either** a valid session (existing behaviour, unchanged —
review page keeps working exactly as today) **or** a valid `token` query
param scoped to this specific receipt id:

```ts
const { id } = await params;
const url = new URL(request.url);
const imageToken = url.searchParams.get("token");

const session = await getSession(request);
const tokenOk = await verifyImageAccessToken(imageToken, id);
if (!session && !tokenOk) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
```

Nothing else in the handler changes — same 404s, same `readReceiptImage`,
same response headers.

## 3. `get_receipt` returns the signed URL

Edit `src/lib/mcp-server.ts`'s `get_receipt` handler (~line 147). Alongside
the existing JSON-text and image-content blocks, add the signed URL as a
field on the JSON payload (not a new content block — keep it inside the
existing `content[0]` text block so it reads naturally as JSON):

```ts
const token = await createImageAccessToken(id);
const imageUrl = `${originFromRequest(request)}/api/receipts/${id}/image?token=${token}`;

const content: ToolContent[] = [
  {
    type: "text",
    text: JSON.stringify({ ...receipt, imageUrl }, null, 2),
  },
  {
    type: "image",
    data: bytes.toString("base64"),
    mimeType: receipt.mimeType,
  },
];
```

Keep the existing `image` content block as-is — Cowork still uses it to
*read/analyse* the receipt in Step 1 of the intake task. `imageUrl` is only
for Step 2's attach call, so it's additive, not a replacement.

`originFromRequest` turned out unnecessary: `src/lib/app-origin.ts` already
exports `appOrigin()`, which derives the origin from `GOOGLE_REDIRECT_URI` —
the same helper `mcpResourceUrl()` in that file already uses. It needs no
`Request` at all, so `get_receipt`'s handler calls it directly
(`${appOrigin()}/api/receipts/${id}/image?token=${token}`) and none of the
anticipated request-threading through the JSON-RPC dispatch chain was
needed. Simpler than planned.

## 4. Updated `docs/SPEC.md` / `CLAUDE_COWORK_TASK.md`

(Note: this repo's own spec has since moved to
`specs/003-receipt-submission/spec.md` in the repository root, keeping its §
numbering — `docs/SPEC.md` is now only a pointer, so the `docs/SPEC.md §N`
references throughout this document still resolve there. It remains distinct
from `docs/RECEIPT_AUTOMATION_SPEC.md`, which lives in the separate
`lilith-accounting` project mounted for Cowork's scheduled task.)

- `docs/SPEC.md` §7/§8: documents `imageUrl` on `get_receipt`'s response and
  the token-based auth path on the image route — done, plus §3.3/§3.4 for the
  proxy exemption §5 below required.
- `CLAUDE_COWORK_TASK.md` Step 2d: now passes `get_receipt`'s `imageUrl`
  straight through as `attach_receipt_to_purchase_invoice`'s `file_url`
  argument — done.
- The `manager-mcp` side (`file_url` support in `attach_receipt_to_purchase_invoice`)
  is also done — built separately in that repo, fetching the URL directly
  with `httpx` and passing the bytes to Playwright's `set_input_files` as an
  in-memory buffer (`{name, mimeType, buffer}`), no temp file at all. Cleaner
  than this doc's original assumption that a local file might be needed.

## 5. Gap this plan missed: the request never reached the route

None of the above accounted for `src/proxy.ts`, which runs ahead of every
route (`docs/SPEC.md` §3.3) and — before this fix — rejected any `/api/*`
request with neither a session cookie nor a `Bearer` header, unconditionally,
for every path except a fixed prefix allowlist. `manager-mcp` fetching
`imageUrl` sends neither (that's the whole point of an unauthenticated URL),
so the middleware returned `401` before `route.ts`'s token check — built and
correct per §2 above — ever ran. This shipped to production and was only
caught live: Cowork reported the attach failing with `401` on both the
original token and a freshly-minted one, which ruled out an expiry race and
pointed at something rejecting every token unconditionally.

Fix: `src/proxy.ts` gained a `PUBLIC_PATTERNS` regex list alongside its
existing prefix list, matching only `GET /api/receipts/:id/image` (not
`/review`, `/status`, or `DELETE` on the same resource id — those stay fully
gated) — the same "defers the decision to the route" treatment `/mcp`
already gets. Worth remembering for any future unauthenticated-by-design
route: the route-level check alone is not sufficient in this app: the
middleware gate has to be told about it too.

## Out of scope / non-goals

- No change to the existing session-cookie/Bearer auth path — `token` is
  purely additive.
- No new environment variable or secret — reuses `SESSION_SECRET`.
- Not a general-purpose signed-URL feature — scoped to one receipt id, one
  route, 10-minute TTL, single use is fine (no need to invalidate after
  first fetch; expiry is the only guard).
