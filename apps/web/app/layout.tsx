import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "图策 ArchFlow｜建筑设计智能工作台",
  description: "面向建筑设计团队的方案设计、投标文件与施工图协同工作台。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
