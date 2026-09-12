import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  metadataBase: new URL("https://open-harness-workspace.alive-cabin-2798.chatgpt.site"),
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
