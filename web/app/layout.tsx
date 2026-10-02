import type { Metadata } from "next";
import Script from "next/script";
import { themeBootScript } from "@/lib/theme-script";
import "./globals.css";

export const metadata: Metadata = {
  title: "HarnessHub",
  description: "HarnessHub 控制台",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        {children}
        <Script id="theme-boot" strategy="beforeInteractive">
          {themeBootScript}
        </Script>
      </body>
    </html>
  );
}
