/**
 * Home-page labels in English and Telugu. Only the station home is labelled in Telugu; case screens and table
 * contents stay in English (the page says so when Telugu is on). Names are never transliterated.
 */
export type Lang = "en" | "te";

const TE_MONTH: Record<string, string> = {
  January: "జనవరి",
  February: "ఫిబ్రవరి",
  March: "మార్చి",
  April: "ఏప్రిల్",
  May: "మే",
  June: "జూన్",
  July: "జూలై",
  August: "ఆగస్టు",
  September: "సెప్టెంబర్",
  October: "అక్టోబర్",
  November: "నవంబర్",
  December: "డిసెంబర్",
};

export interface HomeLabelInput {
  name: string;
  partOfDay: "morning" | "afternoon" | "evening";
  actionCases: number;
  /** The actions those cases need (the "Need action" figure). */
  actions: number;
  /** Of them, the actions in the viewer's own cases (My cases) and in how many; and those on other officers' cases. */
  own: { actions: number; cases: number };
  other: { actions: number; cases: number };
  overnight: number;
  mine: number;
  lost6Cases: number;
  from: string;
  to: string;
  /** The viewer's own FIRs (as IO): open now, and closed. */
  firs: { open: number; closed: number };
  heldAccounts: number;
}

const nActions = (n: number) => `${n} ${n === 1 ? "action" : "actions"}`;
const otherCases = (n: number) => (n === 1 ? "another officer's case" : `${n} other officers' cases`);

/** "21 actions need you today: 20 in all 11 of your cases, and 1 in another officer's case." */
export function helloActions(v: Pick<HomeLabelInput, "actions" | "mine" | "own" | "other">): string {
  if (v.actions === 0) return "Nothing needs you today.";
  const need = `${nActions(v.actions)} ${v.actions === 1 ? "needs" : "need"} you today`;
  const yours = v.own.cases === v.mine ? (v.mine === 1 ? "in your case" : `in all ${v.mine} of your cases`) : `in ${v.own.cases} of your ${v.mine} ${v.mine === 1 ? "case" : "cases"}`;
  if (!v.other.actions) return `${need}, ${yours}.`;
  if (!v.own.actions) return `${need}, in ${otherCases(v.other.cases)}.`;
  return `${need}: ${v.own.actions} ${yours}, and ${v.other.actions} in ${otherCases(v.other.cases)}.`;
}

export function homeLabels(lang: Lang, v: HomeLabelInput) {
  if (lang === "te") {
    const greet = v.partOfDay === "morning" ? "శుభోదయం" : v.partOfDay === "afternoon" ? "శుభ మధ్యాహ్నం" : "శుభ సాయంత్రం";
    const m = (x: string) => TE_MONTH[x] ?? x;
    return {
      hello: `${greet}, ${v.name}`,
      helloSub: `${v.actions === 0 ? "ఈరోజు మీకు చర్యలేవీ లేవు." : `ఈరోజు మీకు ${v.actions} చర్యలు: మీ ${v.mine} కేసుల్లో ${v.own.cases} కేసుల్లో ${v.own.actions}${v.other.actions ? `, ఇతర అధికారుల ${v.other.cases} కేసుల్లో ${v.other.actions}` : ""}.`} ${v.overnight} జవాబులు కొత్తగా వచ్చాయి.`,
      inbox: "జవాబుల ఇన్‌బాక్స్",
      newFir: "కొత్త FIR",
      need: "చర్య అవసరం",
      needSub: `ఈరోజు చేయాల్సినవి, ${v.actionCases} కేసుల్లో`,
      lost6: "గత 6 నెలల నష్టం",
      lost6Sub: `${v.lost6Cases} ఫిర్యాదుల్లో · ${m(v.from)} నుంచి ${m(v.to)} వరకు`,
      firs: "నా FIRలు",
      firsSub: `ఇప్పుడు తెరిచి ఉన్నవి · ${v.firs.closed} మూసినవి`,
      held: "బాధితుల కోసం నిలిపినది",
      heldSub: `${v.heldAccounts} ఖాతాల్లో`,
      closed: "మూసినవి",
      search: "కేసులు వెతకండి",
      complainant: "ఫిర్యాదుదారు",
      officer: "అధికారి",
      registered: "నమోదు",
      lost: "నష్టపోయిన మొత్తం",
      heldCol: "నిలిపినది",
      stands: "స్థితి",
      allCases: "అన్ని కేసులు",
      myCases: "నా కేసులు",
      actionT: "ఈరోజు చర్య అవసరమైనవి",
      closedT: "మూసిన కేసులు",
      trendsT: "ధోరణులు",
      langLabel: "Switch the labels back to English",
      langBtn: "English",
    };
  }
  return {
    hello: `Good ${v.partOfDay}, ${v.name}`,
    // The same figure as the "Need action" card. "Your cases" are the ones in My cases; a supervisor's actions on other
    // officers' cases are counted apart, so the numbers always match the lists.
    helloSub: `${helloActions(v)} ${v.overnight === 0 ? "No replies" : v.overnight === 1 ? "1 reply" : `${v.overnight} replies`} arrived since yesterday evening.`,
    inbox: "Replies inbox",
    newFir: "New FIR",
    need: "Need action",
    needSub: `to do today, across ${v.actionCases} ${v.actionCases === 1 ? "case" : "cases"}`,
    lost6: "Amount lost, last 6 months",
    lost6Sub: `across ${v.lost6Cases} complaints · ${v.from} to ${v.to}`,
    firs: "My FIRs",
    firsSub: `open now · ${v.firs.closed} closed`,
    held: "Held for victims",
    heldSub: `across ${v.heldAccounts} accounts`,
    closed: "Closed",
    search: "Search cases",
    complainant: "Complainant",
    officer: "Officer",
    registered: "Registered",
    lost: "Amount Lost",
    heldCol: "Held",
    stands: "Where it stands",
    allCases: "All cases",
    myCases: "My cases",
    actionT: "Need action today",
    closedT: "Closed cases",
    trendsT: "Trends",
    langLabel: "తెలుగు లేబుల్స్‌కు మారండి (switch the labels to Telugu)",
    langBtn: "తెలుగు",
  };
}

export type HomeLabels = ReturnType<typeof homeLabels>;
