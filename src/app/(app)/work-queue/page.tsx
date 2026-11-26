import { redirect } from "next/navigation";

/** The work queue is now the dashboard's "Needs action" list. */
export default function WorkQueuePage() {
  redirect("/?tab=action");
}
