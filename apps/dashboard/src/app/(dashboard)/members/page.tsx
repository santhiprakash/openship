import { redirect } from "next/navigation";

/**
 * Legacy route — members management lives under Settings now.
 * Existing links and invitation emails redirect here.
 */
export default function MembersRedirect() {
  redirect("/settings?tab=team");
}
