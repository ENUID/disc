import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Disc",
  description: "The AI boutique for your Shopify store.",
  // A merchant console has no business being indexed, and the URL can
  // carry a session token on the first hop.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
