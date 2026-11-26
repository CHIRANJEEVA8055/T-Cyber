import { redirect } from "next/navigation";

/** The station mailbox is now the dashboard's replies inbox; each case reads replies in from its Requests screen. */
export default function CorrespondencePage() {
  redirect("/?replies=1");
}
