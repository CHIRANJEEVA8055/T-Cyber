/**
 * Opens an evidence item at the cited place: "p. 2", "line 5" and "row 3" in a locator become the viewer's
 * page, line and row parameters, so a citation lands on the exact text it refers to.
 */
export function evidenceHref(caseId: string, evidenceId: string, locator?: string | null): string {
  const params = new URLSearchParams();
  const page = /p\. (\d+)/.exec(locator ?? "")?.[1];
  const line = /line (\d+)/.exec(locator ?? "")?.[1];
  const row = /row (\d+)/.exec(locator ?? "")?.[1];
  if (page) params.set("page", page);
  if (line) params.set("line", line);
  if (row) params.set("row", row);
  return `/cases/${caseId}/evidence/${evidenceId}${params.size ? `?${params}` : ""}`;
}

/** "Title, line 6", without repeating the title when the locator already starts with it. */
export function citationLabel(title: string | undefined, locator: string): string {
  return title && !locator.startsWith(title) ? `${title}, ${locator}` : locator;
}
