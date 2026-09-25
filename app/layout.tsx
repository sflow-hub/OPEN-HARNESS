import type { Metadata, Viewport } from "next";
import "./globals.css";

// Respect display safe areas and resize the layout when a browser keyboard opens.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#121314",
};
export const metadata: Metadata = {
  // Was a hard-coded domain from the scaffold this project started as, which meant every
  // self-hosted deployment resolved its social-card image against someone else's host.
  metadataBase: new URL(process.env.OPEN_HARNESS_PUBLIC_URL || "http://localhost:3000"),
  // Lets a phone browser install the dashboard to the home screen and run it without
  // browser chrome, which is most of what makes the browser path feel like the app.
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Open Harness", statusBarStyle: "black-translucent" },
  title: "Open Harness — Your personal agent workspace",
  description:
    "An open-source workspace for persistent agents, useful tools, and work you own.",
  openGraph: {
    title: "Open Harness",
    description: "Your agents. Your models. Your work.",
    images: [{ url: "/og.png", width: 1734, height: 907, alt: "Open Harness — Your agents. Your models. Your work." }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Open Harness",
    description: "Your agents. Your models. Your work.",
    images: ["/og.png"],
  },
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
