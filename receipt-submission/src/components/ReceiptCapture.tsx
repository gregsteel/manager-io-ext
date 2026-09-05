"use client";

import Link from "next/link";

export function ReceiptCapture({
  userEmail,
  showUpload,
}: {
  userEmail: string;
  showUpload: boolean;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header
        className="px-5 pb-2"
        style={{ paddingTop: "max(1.25rem, var(--safe-top))" }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium tracking-wide text-muted uppercase">
              Receipts
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
              Scan on iPhone
            </h1>
          </div>
          <form action="/auth/logout" method="post" className="shrink-0 pt-0.5">
            <button
              type="submit"
              className="text-sm text-muted underline-offset-2 transition-colors hover:text-foreground hover:underline"
              title={userEmail}
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main
        className="flex flex-1 flex-col px-5"
        style={{ paddingBottom: "max(1.5rem, var(--safe-bottom))" }}
      >
        <div className="animate-fade-in flex flex-1 flex-col items-center justify-center gap-6 text-center">
          <p className="max-w-sm text-base leading-relaxed text-muted">
            Capture only works in the Receipts iOS app, which detects and crops
            the receipt on device. The browser does not crop or upload photos.
          </p>
          <a
            href="receipts://"
            className="flex h-14 w-full max-w-xs items-center justify-center rounded-xl bg-accent text-base font-semibold text-surface transition-colors active:bg-accent-pressed"
          >
            Open Receipts app
          </a>
          <p className="max-w-xs text-sm leading-relaxed text-muted">
            Install it from TestFlight if it is not on this phone yet.
          </p>
          <Link
            href="/receipts"
            className="flex h-12 w-full max-w-xs items-center justify-center rounded-xl border border-accent/30 bg-accent-soft text-sm font-semibold text-accent-pressed transition-colors hover:border-accent/50"
          >
            Review receipts
          </Link>
          {showUpload ? (
            <Link
              href="/upload"
              className="text-sm text-accent underline-offset-2 hover:underline"
            >
              Or upload from this computer
            </Link>
          ) : null}
        </div>
      </main>
    </div>
  );
}
