import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { orNotFound } from "@/server/not-found";
import { getGraphData } from "@/server/services/graph";
import { getCaseWindow } from "@/server/services/case-home";
import { CaseGraph } from "@/features/graph/components/case-graph";

export const metadata: Metadata = { title: "Graph & timeline" };

/** Graph & timeline (design: Graph artboard): money flow, identity, discovery phases and the timeline. */
export default async function GraphPage({ params }: { params: Promise<{ caseId: string }> }) {
  const user = await requireUser();
  const { caseId } = await params;
  const db = getDb();
  const [data, w] = await Promise.all([orNotFound(getGraphData(db, user, caseId)), orNotFound(getCaseWindow(db, user, caseId))]);
  return (
    <>
      <header className="casehead" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16 }}>
        <div style={{ flex: "1 1 360px", minWidth: 0 }}>
          <div className="mut" style={{ fontSize: 13 }}>
            <Link href={`/cases/${caseId}`}>{w.ref}</Link>
            <span style={{ margin: "0 6px" }} aria-hidden="true">
              /
            </span>
            Graph &amp; Timeline
          </div>
          <h1 className="h" style={{ fontSize: 28 }}>
            Graph and Timeline
          </h1>
          <p className="sec" style={{ margin: "10px 0 0", fontSize: 15 }}>
            Where the money went, who is linked to what, what each record added, and when. Every line is a recorded fact with its source.
          </p>
        </div>
      </header>
      <div className="casepad" style={{ width: "100%", maxWidth: 1400 }}>
        <CaseGraph caseId={caseId} data={data} />
      </div>
    </>
  );
}
