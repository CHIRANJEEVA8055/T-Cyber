import { getAppConfig } from "../config";

/**
 * The local model (Ollama on this server). Used only where rules cannot do the work: reading scanned pages,
 * translating Telugu or Hindi, and wording free answers. Its output is treated as data to be checked, never as an
 * instruction, and every use is labelled in the interface. When it is not running, callers say so plainly and fall
 * back to rules or to the officer.
 */
export interface LocalModelStatus {
  enabled: boolean;
  reachable: boolean;
  hasModel: boolean;
  model: string;
  host: string;
  note: string;
}

const offline = () => process.env.T_CYBER_DISABLE_NETWORK === "1";

async function call(path: string, init: RequestInit, timeoutMs: number) {
  const cfg = getAppConfig().ai;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(new URL(path, cfg.host), { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function localModelStatus(): Promise<LocalModelStatus> {
  const cfg = getAppConfig().ai;
  const base = { enabled: cfg.provider === "ollama", model: cfg.model, host: cfg.host };
  if (cfg.provider !== "ollama") return { ...base, reachable: false, hasModel: false, note: "The local model is switched off in the station configuration. Rules answer everything they can." };
  if (offline()) return { ...base, reachable: false, hasModel: false, note: "Network access is disabled in this environment." };
  try {
    const res = await call("/api/tags", { method: "GET" }, 2000);
    if (!res.ok) return { ...base, reachable: false, hasModel: false, note: `The local model service answered with status ${res.status}.` };
    const body = (await res.json()) as { models?: { name: string }[] };
    const hasModel = (body.models ?? []).some((m) => m.name === cfg.model || m.name === `${cfg.model}:latest`);
    return { ...base, reachable: true, hasModel, note: hasModel ? `${cfg.model} is ready on this server.` : `The local model service is running but ${cfg.model} is not installed (ollama pull ${cfg.model}).` };
  } catch {
    return { ...base, reachable: false, hasModel: false, note: `The local model is not running on this server. An administrator can start it with: sudo systemctl enable --now ollama` };
  }
}

export type LocalResult = { ok: true; text: string; model: string; ms: number } | { ok: false; error: string };

export interface GenerateOptions {
  prompt: string;
  system?: string;
  images?: Buffer[];
  timeoutSeconds?: number;
  /** 0 (the default) for answers that must stay with their sources; a little higher for general conversation. */
  temperature?: number;
  /** Upper bound on the answer's length in tokens. */
  maxTokens?: number;
  /**
   * Whether a thinking model (gemma4) reasons before answering. Off by default: on this server it multiplies the
   * time to answer many times over (a one-line reply goes from about 0.1 s to 2.5 s) without changing short answers.
   */
  think?: boolean;
  /** "json": the model must answer with a single JSON value (Ollama's structured output). */
  format?: "json";
}

/** The request body sent to Ollama's /api/generate. */
export function generateBody(model: string, opts: GenerateOptions) {
  return {
    model,
    prompt: opts.prompt,
    system: opts.system,
    images: opts.images?.map((b) => b.toString("base64")),
    stream: false,
    think: opts.think ?? false,
    ...(opts.format ? { format: opts.format } : {}),
    options: { temperature: opts.temperature ?? 0, ...(opts.maxTokens ? { num_predict: opts.maxTokens } : {}) },
  };
}

export async function localGenerate(opts: GenerateOptions): Promise<LocalResult> {
  const status = await localModelStatus();
  if (!status.reachable || !status.hasModel) return { ok: false, error: status.note };
  const cfg = getAppConfig().ai;
  const started = Date.now();
  try {
    const res = await call(
      "/api/generate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(generateBody(cfg.model, opts)),
      },
      (opts.timeoutSeconds ?? cfg.timeoutSeconds) * 1000,
    );
    if (!res.ok) return { ok: false, error: `The local model could not answer (status ${res.status}).` };
    const body = (await res.json()) as { response?: string };
    return { ok: true, text: (body.response ?? "").trim(), model: cfg.model, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: (err as Error).name === "AbortError" ? "The local model took too long and was stopped." : "The local model could not be reached." };
  }
}
