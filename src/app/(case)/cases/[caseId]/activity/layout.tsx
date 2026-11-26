import { SubNav } from "@/components/app/sub-nav";

export default async function ActivityLayout({ children, params }: { children: React.ReactNode; params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  const base = `/cases/${caseId}/activity`;
  return (
    <>
      <SubNav
        label="Activity and reports sections"
        items={[
          { href: base, label: "Activity", exact: true },
          { href: `${base}/reports`, label: "Reports" },
          { href: `${base}/handover`, label: "Handover" },
        ]}
      />
      {children}
    </>
  );
}
