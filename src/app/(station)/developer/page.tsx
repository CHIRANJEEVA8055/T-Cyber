import { redirect } from "next/navigation";
import { requireDeveloper } from "@/server/auth/current-user";

export default async function DeveloperHome() {
  await requireDeveloper();
  redirect("/developer/knowledge");
}
