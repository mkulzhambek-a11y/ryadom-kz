import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Служебный проект",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: 32 }}>{children}</body>
    </html>
  );
}
