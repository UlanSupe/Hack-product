"use client";

/**
 * The page-level safety net. It says that something broke and where to go next; it never prints the error's own text,
 * which could carry paths or internals. `digest` is Next's opaque id for finding the matching server log line.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="wrap" id="main">
      <section className="card" role="alert" aria-labelledby="err-h">
        <div className="card__head">
          <h1 id="err-h">Something went wrong on this page</h1>
        </div>
        <p>
          The page could not be shown. Nothing was paid or changed by this error. You can try again,
          or go back to the start; your transactions are kept on the server and listed there.
        </p>
        {error.digest ? (
          <p className="muted small">
            Reference for the server log: <code className="code">{error.digest}</code>
          </p>
        ) : null}
        <div className="row">
          <button type="button" className="btn btn--primary" onClick={reset}>
            Try again
          </button>
          <a className="btn btn--quiet" href="/">
            Back to the start
          </a>
          <a className="btn btn--quiet" href="/api/health">
            Diagnostics
          </a>
        </div>
      </section>
    </main>
  );
}
