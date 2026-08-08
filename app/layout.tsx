import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const imageUrl = `${protocol}://${host}/og.png`;
  return {
    title: "Plate Studio",
    description: "A precise, browser-based editor for statistical plate diagrams.",
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      title: "Plate Studio",
      description: "Create, edit, and export publication-ready statistical plate diagrams.",
      type: "website",
      images: [{ url: imageUrl, width: 1200, height: 630, alt: "Plate Studio statistical diagram editor" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Plate Studio",
      description: "Create, edit, and export publication-ready statistical plate diagrams.",
      images: [imageUrl],
    },
  };
}

const mathJaxConfig = `
window.MathJax = {
  output: { linebreaks: { inline: false } },
  svg: { fontCache: 'local' },
  options: { enableMenu: false }
};`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: mathJaxConfig }} />
        <script defer src="https://cdn.jsdelivr.net/npm/mathjax@4/tex-svg.js" />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
