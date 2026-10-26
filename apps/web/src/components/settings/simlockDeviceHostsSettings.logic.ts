import {
  SimlockDeviceHostConfig,
  type SimlockDeviceHostConfig as SimlockDeviceHostConfigType,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const parseSimlockDeviceHostDraft = Schema.decodeUnknownOption(SimlockDeviceHostConfig);

export const newSimlockDeviceHost = (id: string): SimlockDeviceHostConfigType => ({
  kind: "simlock",
  id,
  label: "Simlock",
  gatewayUrl: "",
  agentToken: "",
  operatorToken: "",
  maxLeases: 2,
  maxLeaseMinutes: 60,
});

/** Adds, replaces, or removes one Simlock host. */
export function updateSimlockDeviceHosts(
  hosts: ReadonlyArray<SimlockDeviceHostConfigType>,
  host: SimlockDeviceHostConfigType,
  remove: boolean,
): ReadonlyArray<SimlockDeviceHostConfigType> {
  if (remove) return hosts.filter((candidate) => candidate.id !== host.id);
  return hosts.some((candidate) => candidate.id === host.id)
    ? hosts.map((candidate) => (candidate.id === host.id ? host : candidate))
    : [...hosts, host];
}

/** Why Save is off, or null when the host can be saved. */
export function simlockDeviceHostProblem(host: SimlockDeviceHostConfigType): string | null {
  if (Option.isSome(parseSimlockDeviceHostDraft(host))) {
    return host.agentToken ? null : "Add an agent token.";
  }
  if (!host.label.trim()) return "Give the host a label.";
  // With in-range limits, a draft that still fails has a bad gateway URL.
  return Option.isNone(parseSimlockDeviceHostDraft({ ...host, maxLeases: 1, maxLeaseMinutes: 60 }))
    ? "Enter the gateway's origin, such as https://gateway.example.ts.net:4700."
    : "Keep the limits within the ranges shown.";
}

export function simlockLeaseLimits(host: SimlockDeviceHostConfigType) {
  const devices = host.maxLeases === 1 ? "1 device" : `${host.maxLeases} devices`;
  return `Up to ${devices} at once, each released after ${host.maxLeaseMinutes} min`;
}
