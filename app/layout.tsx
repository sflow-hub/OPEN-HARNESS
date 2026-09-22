import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  // Was a hard-coded domain from the scaffold this project started as, which meant every
  // self-hosted deployment resolved its social-card image against someone else's host.
  metadataBase: new URL(process.env.OPEN_HARNESS_PUBLIC_URL || "http://localhost:3000"),
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
