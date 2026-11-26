import { SubNav } from "@/components/app/sub-nav";
import { requireCaseWorker } from "@/server/auth/current-user";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  // Station settings are for officers (read) and supervisors (change); the developer has the developer console.
  await requireCaseWorker();
  return (
    <>
      <SubNav
        label="Settings sections"
        items={[
          { href: "/settings", label: "Overview", exact: true },
          { href: "/settings/directory", label: "Recipient directory" },
          { href: "/settings/nodal", label: "Nodal officers" },
          { href: "/settings/routes", label: "Routes" },
          { href: "/settings/templates", label: "Templates" },
          { href: "/settings/integrations", label: "Integrations" },
          { href: "/settings/knowledge", label: "Knowledge library" },
          { href: "/settings/demo", label: "Demonstration data" },
        ]}
      />
      {children}
    </>
  );
}
