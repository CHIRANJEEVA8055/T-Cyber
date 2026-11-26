/**
 * Defence in depth for cookie-authenticated route handlers (server actions already check origin):
 * reject cross-site POSTs. The session cookie is also SameSite=Lax.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // same-origin form posts from older clients may omit it; SameSite still applies
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}
