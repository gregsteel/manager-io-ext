import { redirect } from "next/navigation";
import { ReceiptUpload } from "@/components/ReceiptUpload";
import { getSession } from "@/lib/auth/session";

export default async function UploadPage() {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  return <ReceiptUpload />;
}
