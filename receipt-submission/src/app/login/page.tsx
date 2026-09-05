type LoginPageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const error = params.error?.trim();

  return (
    <main
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5"
      style={{
        paddingTop: "max(1.5rem, var(--safe-top))",
        paddingBottom: "max(1.5rem, var(--safe-bottom))",
      }}
    >
      <div className="animate-fade-in">
        <p className="text-sm font-medium tracking-wide text-muted uppercase">
          Receipts
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">
          Sign in to continue
        </h1>
        <p className="mt-3 text-base leading-relaxed text-muted">
          Use your Google account. Access is limited to allowed users.
        </p>

        {error ? (
          <p
            className="mt-5 rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        <a
          href="/auth/google"
          className="mt-8 flex h-14 w-full items-center justify-center gap-3 rounded-xl bg-accent text-base font-semibold text-surface transition-colors active:bg-accent-pressed"
        >
          <GoogleIcon className="h-5 w-5" />
          Continue with Google
        </a>
      </div>
    </main>
  );
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M21.6 12.23c0-.74-.07-1.45-.19-2.13H12v4.03h5.38a4.6 4.6 0 0 1-2 3.02v2.5h3.24c1.89-1.74 2.98-4.3 2.98-7.42Z"
        opacity=".9"
      />
      <path
        fill="currentColor"
        d="M12 22c2.7 0 4.96-.9 6.62-2.35l-3.24-2.5c-.9.6-2.04.96-3.38.96-2.6 0-4.8-1.76-5.59-4.12H3.07v2.58A10 10 0 0 0 12 22Z"
        opacity=".75"
      />
      <path
        fill="currentColor"
        d="M6.41 13.99A6.01 6.01 0 0 1 6.1 12c0-.69.12-1.36.31-1.99V7.43H3.07A10 10 0 0 0 2 12c0 1.61.39 3.14 1.07 4.57l3.34-2.58Z"
        opacity=".6"
      />
      <path
        fill="currentColor"
        d="M12 5.88c1.47 0 2.79.5 3.83 1.5l2.87-2.87C16.95 2.9 14.7 2 12 2A10 10 0 0 0 3.07 7.43l3.34 2.58C7.2 7.64 9.4 5.88 12 5.88Z"
        opacity=".8"
      />
    </svg>
  );
}
