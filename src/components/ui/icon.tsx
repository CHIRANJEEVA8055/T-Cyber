import type { CSSProperties, ReactNode } from "react";

/**
 * The design's own inline icons (24px grid, round caps), copied path for path from the Cyber Investigation
 * Workspace canvas so every glyph matches. Stroke icons inherit currentColor; `dots` is filled.
 */
const ICONS = {
  grid: { fill: false, d: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></> },
  x: { fill: false, d: <><path d="M6 6l12 12M18 6 6 18" /></> },
  chevronLeft: { fill: false, d: <><path d="m15 6-6 6 6 6" /></> },
  chevronRight: { fill: false, d: <><path d="m9 6 6 6-6 6" /></> },
  sidebar: { fill: false, d: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></> },
  bolt: { fill: false, d: <><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" /></> },
  people: { fill: false, d: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4a3.5 3.5 0 0 1 0 7" /><path d="M18 14.5a6 6 0 0 1 3.5 5.5" /></> },
  card: { fill: false, d: <><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18" /><path d="M16 15h2" /></> },
  mail: { fill: false, d: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></> },
  file: { fill: false, d: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></> },
  graph: { fill: false, d: <><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="8" r="2.5" /><circle cx="12" cy="18" r="2.5" /><path d="M8.5 6.4 15.5 7.6M7.2 8.2l3.6 7.6M16.8 10.3l-3.4 5.5" /></> },
  chat: { fill: false, d: <><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12z" /></> },
  clock: { fill: false, d: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></> },
  calendar: { fill: false, d: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></> },
  report: { fill: false, d: <><path d="M6 3h9l4 4v14H6z" /><path d="M9 12h6M9 16h6M9 8h3" /></> },
  book: { fill: false, d: <><path d="M4 5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2z" /><path d="M4 21V5" /><path d="M8 7h8" /></> },
  help: { fill: false, d: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7" /><path d="M12 17h.01" /></> },
  alertCircle: { fill: false, d: <><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></> },
  shield: { fill: false, d: <><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" /></> },
  paperclip: { fill: false, d: <><path d="m21 12-8.5 8.5a5 5 0 0 1-7-7L14 5a3.3 3.3 0 0 1 4.7 4.7L10.5 18a1.7 1.7 0 0 1-2.4-2.4L16 7.7" /></> },
  arrowUp: { fill: false, d: <><path d="M12 19V5M5 12l7-7 7 7" /></> },
  home: { fill: false, d: <><path d="M3 11 12 4l9 7" /><path d="M5 10v10h14V10" /><path d="M10 20v-6h4v6" /></> },
  globe: { fill: false, d: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></> },
  bell: { fill: false, d: <><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z" /><path d="M10 20a2 2 0 0 0 4 0" /></> },
  sun: { fill: false, d: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></> },
  moon: { fill: false, d: <><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></> },
  pencil: { fill: false, d: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></> },
  search: { fill: false, d: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></> },
  dots: { fill: true, d: <><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></> },
  export: { fill: false, d: <><path d="M12 3v12m0 0 4-4m-4 4-4-4" /><path d="M4 17v3h16v-3" /></> },
  archive: { fill: false, d: <><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v12h14V8" /><path d="M10 12h4" /></> },
  trash: { fill: false, d: <><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></> },
  chevronDown: { fill: false, d: <><path d="m6 9 6 6 6-6" /></> },
  check: { fill: false, d: <><path d="m5 12 5 5L20 7" /></> },
  bookOpen: { fill: false, d: <><path d="M4 5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2z" /><path d="M4 21V5" /></> },
  copy: { fill: false, d: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h10" /></> },
  thumbsUp: { fill: false, d: <><path d="M7 10v11H4V10zM7 10l4-7a2.5 2.5 0 0 1 2.5 2.5V9H19a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.8 20H7" /></> },
  thumbsDown: { fill: false, d: <><path d="M17 14V3h3v11zM17 14l-4 7a2.5 2.5 0 0 1-2.5-2.5V15H5a2 2 0 0 1-2-2.3l1.2-7A2 2 0 0 1 6.2 4H17" /></> },
  retry: { fill: false, d: <><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v6h-6" /></> },
  upload: { fill: false, d: <><path d="M12 16V4m0 0 4 4m-4-4-4 4" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></> },
  folder: { fill: false, d: <><path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /></> },
  plus: { fill: false, d: <><path d="M12 5v14M5 12h14" /></> },
  info: { fill: false, d: <><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v4h1" /></> },
  arrowDown: { fill: false, d: <><path d="M12 5v14M5 12l7 7 7-7" /></> },
  arrowRightLong: { fill: false, d: <><path d="M5 12h14M13 6l6 6-6 6" /></> },
  filter: { fill: false, d: <><path d="M3 5h18l-7 8v5l-4 2v-7z" /></> },
  pen: { fill: false, d: <><path d="M4 20h4l10-10-4-4L4 16z" /><path d="m13 7 4 4" /></> },
  fileUpload: { fill: false, d: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M12 18v-6m0 0-2.5 2.5M12 12l2.5 2.5" /></> },
  spinner: { fill: false, d: <><path d="M21 12a9 9 0 1 1-6.2-8.6" /></> },
  minus: { fill: false, d: <><path d="M5 12h14" /></> },
  arrowRight: { fill: false, d: <><path d="M5 12h14m-6-6 6 6-6 6" /></> },
  alert: { fill: false, d: <><circle cx="12" cy="12" r="9" /><path d="M12 8v4m0 4h.01" /></> },
  download: { fill: false, d: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></> },
  circle: { fill: false, d: <><circle cx="12" cy="12" r="9" /></> },
} satisfies Record<string, { fill: boolean; d: ReactNode }>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size, strokeWidth = 2, className, style, label }: { name: IconName; size?: number; strokeWidth?: number; className?: string; style?: CSSProperties; label?: string }) {
  const icon = ICONS[name];
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={icon.fill ? "currentColor" : "none"}
      stroke={icon.fill ? undefined : "currentColor"}
      strokeWidth={icon.fill ? undefined : strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {icon.d}
    </svg>
  );
}
