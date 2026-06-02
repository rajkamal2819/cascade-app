import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Cascade — Real-time market intelligence",
  description: "Real-time market cascade intelligence powered by MongoDB and Gemini.",
};

// Read the saved theme before paint so a reload in light mode doesn't flash dark first.
const themeBoot = `
  try {
    var t = localStorage.getItem('cascade-theme');
    if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
  } catch (e) {}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
