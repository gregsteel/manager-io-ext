import { headers } from "next/headers";

// Upload-from-file only makes sense on a desktop browser — on a phone the
// native app (or its camera) is always the better path, and the iOS app
// itself never renders these pages (it's pure SwiftUI, no WKWebView), so a
// mobile user-agent here always means mobile Safari/Chrome, not the app.
const MOBILE_UA = /Mobi|Android|iPhone|iPad|iPod/i;

export async function isMobileRequest(): Promise<boolean> {
  const userAgent = (await headers()).get("user-agent") ?? "";
  return MOBILE_UA.test(userAgent);
}
