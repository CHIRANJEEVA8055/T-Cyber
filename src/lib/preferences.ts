/** Per-browser display preferences, kept in cookies so the server renders them without a flash. */
export const THEME_COOKIE = "tc_theme";
export const LANG_COOKIE = "tc_lang";
export const NAV_COOKIE = "tc_nav";

export type Theme = "dark" | "light";
export type Lang = "en" | "te";

/** Client only: remembers a preference for a year. */
export function setPreference(name: string, value: string) {
  document.cookie = `${name}=${value}; path=/; max-age=31536000; samesite=lax`;
}
