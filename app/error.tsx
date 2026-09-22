"use client";

import { useEffect } from "react";

// Without a boundary, one render-time throw leaves a blank page and no way back:
// the coordinator is still running and the work is still safe, but nothing says so.
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Open Harness dashboard error:", error);
  }, [error]);

  return (
    <div className="fatal">
      <div className="fatal-card">
        <h1>The dashboard hit an error.</h1>
        <p>
          Your agents, files, and run history are kept by the local control service, not
          by this page. Nothing here has been lost.
        </p>
        <pre>{error.message || "Unknown error"}</pre>
        <div className="fatal-actions">
          <button className="light-button" onClick={reset}>Try again</button>
          <button className="subtle-button" onClick={() => window.location.reload()}>Reload</button>
        </div>
        {error.digest && <small>Reference {error.digest}</small>}
      </div>
    </div>
  );
}
