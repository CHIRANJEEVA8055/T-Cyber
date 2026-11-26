import { redirect } from "next/navigation";

/** The guidance library is now the procedure assistant in the station shell. */
export default function GuidancePage() {
  redirect("/assistant");
}
