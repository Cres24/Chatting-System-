import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Chatting System",
  description: "A small realtime chat app on Vercel, Neon Postgres, and Ably.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
