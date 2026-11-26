import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { getCaseWindow } from "@/server/services/case-home";
import { AppError } from "@/server/errors";
import { NAV_COOKIE } from "@/lib/preferences";
import { CaseWindow } from "@/features/case/components/case-window";

export default async function CaseLayout({ children, params }: { children: React.ReactNode; params: Promise<{ caseId: string }> }) {
  const user = await requireUser();
  const { caseId } = await params;
  let data;
  try {
    data = await getCaseWindow(getDb(), user, caseId);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const store = await cookies();
  return (
    <CaseWindow data={data} navOpen={store.get(NAV_COOKIE)?.value !== "min"}>
      {children}
    </CaseWindow>
  );
}
