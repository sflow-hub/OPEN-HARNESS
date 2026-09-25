"use client";

import { useEffect } from "react";

// error.tsx cannot catch a throw from the root layout or the shell around it, which would
// otherwise render as an unstyled blank page. This boundary replaces the whole document, so
// it carries its own markup and inline styles rather than relying on globals.css loading.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Open Harness dashboard failed to render:", error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", background: "#1b201a", color: "#d5e3ca", fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
        <main style={{ maxWidth: "34rem", padding: "28px", border: "1px solid #49573e", borderRadius: "11px", background: "#232a20" }}>
          <h1 style={{ fontSize: "17px", margin: "0 0 10px" }}>The dashboard could not start.</h1>
          <p style={{ fontSize: "13px", lineHeight: 1.6, margin: "0 0 14px", color: "#b3c4a6" }}>
            Your agents, files, and run history are kept by the local control service, not by this
            page. Nothing here has been lost, and anything already running is still running.
          </p>
          <pre style={{ fontSize: "12px", background: "#00000030", padding: "10px 12px", borderRadius: "7px", overflowX: "auto", margin: "0 0 16px" }}>{error.message || "Unknown error"}</pre>
          <div style={{ display: "flex", gap: "10px" }}>
            <button onClick={reset} style={{ font: "inherit", fontSize: "13px", padding: "8px 14px", borderRadius: "7px", border: "1px solid #6c8256", background: "#3c4a33", color: "#e4efdb", cursor: "pointer" }}>Try again</button>
            <button onClick={() => window.location.reload()} style={{ font: "inherit", fontSize: "13px", padding: "8px 14px", borderRadius: "7px", border: "1px solid #49573e", background: "transparent", color: "#b3c4a6", cursor: "pointer" }}>Reload</button>
          </div>
          {error.digest && <small style={{ display: "block", marginTop: "14px", color: "#8a9a7d" }}>Reference {error.digest}</small>}
        </main>
      </body>
    </html>
  );
}
