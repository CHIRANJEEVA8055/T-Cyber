/**
 * SIMULATION ADAPTERS — no real correspondence is ever sent.
 *
 * Every external channel (bank nodal email, NPCI route, department UNICROSS route) is a local
 * simulation that only returns a synthetic reference. These functions perform no network I/O.
 * Provider portals are not automated at all: the officer submits on the portal and records the
 * reference (see recordPortalSubmission in the request service).
 */
import crypto from "node:crypto";

export const SIMULATED_CHANNELS = {
  EMAIL: { settingKey: "EMAIL_GATEWAY", label: "Simulated email gateway (bank nodal / LEA mailboxes)", inSentence: "the simulated email gateway", prefix: "SIM-EMAIL" },
  UNICROSS: { settingKey: "TELECOM_UNICROSS", label: "Simulated UNICROSS / zonal ACP route", inSentence: "the simulated UNICROSS route", prefix: "SIM-UNICROSS" },
  NPCI_ROUTE: { settingKey: "NPCI_ROUTE", label: "Simulated NPCI / payment-provider route", inSentence: "the simulated NPCI route", prefix: "SIM-NPCI" },
} as const;

export type SimulatedChannel = keyof typeof SIMULATED_CHANNELS;

export function isSimulatedChannel(channel: string): channel is SimulatedChannel {
  return channel in SIMULATED_CHANNELS;
}

export interface SimulatedSendInput {
  channel: SimulatedChannel;
  requestReference: string;
  recipientAddress: string;
  fromAddress: string;
  contentHash: string;
  failureSimulationEnabled: boolean;
}

export type SimulatedSendResult = { ok: true; externalReference: string; adapter: string } | { ok: false; error: string; adapter: string };

export function simulateSend(input: SimulatedSendInput): SimulatedSendResult {
  const meta = SIMULATED_CHANNELS[input.channel];
  if (input.failureSimulationEnabled) {
    return {
      ok: false,
      adapter: meta.label,
      error: `${meta.label} rejected the message because failure simulation is switched on in Settings. Nothing was sent. Switch it off and retry.`,
    };
  }
  const suffix = crypto.createHash("sha256").update(`${input.requestReference}|${input.contentHash}`).digest("hex").slice(0, 8).toUpperCase();
  return { ok: true, adapter: `${meta.label}, from ${input.fromAddress} to ${input.recipientAddress}`, externalReference: `${meta.prefix}-${input.requestReference}-${suffix}` };
}
