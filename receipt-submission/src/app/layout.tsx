import type { Metadata, Viewport } from "next";
import { Outfit } from "next/font/google";
import "./globals.css";

const outfit = Outfit({
  variable: "--font-outfit",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Receipt Submission",
  description: "Capture a receipt and save it on the server.",
  applicationName: "Receipts",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Receipts",
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: "/icon",
    apple: "/apple-icon",
  },
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#e8eef2",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${outfit.variable} h-full antialiased`}>
      <body className="min-h-dvh bg-background font-sans text-foreground">
        <div
          className="min-h-dvh"
          style={{
            background:
              "radial-gradient(120% 80% at 50% -10%, #f7fafc 0%, transparent 55%), linear-gradient(180deg, var(--background) 0%, var(--background-deep) 100%)",
          }}
        >
          {children}
        </div>
      </body>
    </html>
  );
}
