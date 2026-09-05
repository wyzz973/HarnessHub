import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HarnessHub · Agent 工作台",
  description: "一个工作台，连接你的 Agent。规划、执行、观察每一项任务。",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
