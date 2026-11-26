import { redirect } from "next/navigation";

/** A new FIR is opened from the station dashboard's New FIR window. */
export default async function NewCasePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  redirect(typeof sp.ack === "string" ? `/?ack=${encodeURIComponent(sp.ack)}` : "/?newFir=1");
}
