import { ReceiptCapture } from "@/components/ReceiptCapture";
import { getSession } from "@/lib/auth/session";
import { isMobileRequest } from "@/lib/is-mobile-request";
import { redirect } from "next/navigation";

export default async function Home() {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  const isMobile = await isMobileRequest();

  return <ReceiptCapture userEmail={session.email} showUpload={!isMobile} />;
}
