import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge must know the project's custom type scale; otherwise `text-body` is mistaken for a
 * colour and silently removes classes such as `text-white` on primary buttons.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["meta", "label", "body", "section", "heading", "title"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const RANK_SHORT: Record<string, string> = { "Sub-Inspector": "SI", Inspector: "Inspector", "Assistant Sub-Inspector": "ASI", "Head Constable": "HC" };

export function shortRank(rank: string): string {
  return RANK_SHORT[rank] ?? rank;
}
