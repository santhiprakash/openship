import { redirect } from "next/navigation";

/**
 * Legacy route — audit log lives under Settings now.
 */
export default function AuditRedirect() {
  redirect("/settings?tab=audit");
}
