// Deterministic, customer-safe sample selection for the bugs mode.
//
// The sample is stratified by Team (first component when Team is absent) and
// ordered by a stable hash, so two people with the same corpus and seed get the
// same list on any machine. Customer-linked tickets are excluded from the aged
// sample and refused as controls: this path never proposes closing a customer
// bug.
import { createHash } from "node:crypto";
import { ageDays, type BugTicket } from "./bugmodel.ts";

export const DEFAULT_AGED_DAYS = 90;
export const DEFAULT_SAMPLE_SIZE = 12;
export const DEFAULT_SEED = 18094;

export interface Control {
  key: string;
  label: string;
}

export interface SelectionConfig {
  size: number;
  agedDays: number;
  seed: number;
  controls: Control[];
}

export type SelectionKind = "aged" | "control";

export interface Selection {
  ticket: BugTicket;
  kind: SelectionKind;
  stratum: string;
  ageDays: number | null;
  controlLabel?: string;
}

export interface Exclusion {
  key: string;
  reason: string;
}

export interface SelectionResult {
  selected: Selection[];
  excluded: Exclusion[];
  eligible: number;
}

/** Parse repeated `KEY=label` control flags; a bare key gets no label. */
export function parseControls(values: readonly string[]): Control[] {
  return values.map((value) => {
    const separator = value.indexOf("=");
    if (separator === -1) {
      return { key: value.trim(), label: "" };
    }
    return { key: value.slice(0, separator).trim(), label: value.slice(separator + 1).trim() };
  });
}

export function customerReason(ticket: BugTicket): string {
  return ticket.customerSignals[0] ?? "";
}

export function stratumOf(ticket: BugTicket): string {
  if (ticket.team) {
    return ticket.team;
  }
  return ticket.components[0] ?? "Unowned";
}

export function exclusionReason(ticket: BugTicket, asOf: Date, agedDays: number): string {
  const customer = customerReason(ticket);
  if (customer) {
    return `customer-linked (${customer})`;
  }
  if (ticket.isDone) {
    return `done (${ticket.status || "unknown status"})`;
  }
  const age = ageDays(ticket.created, asOf);
  if (age === null) {
    return "created date unreadable";
  }
  if (age < agedDays) {
    return `younger than ${agedDays}d (${age}d)`;
  }
  return "";
}

function stableOrder(key: string, seed: number): string {
  return createHash("sha256").update(`${seed}:${key}`).digest("hex");
}

export function selectSample(
  tickets: readonly BugTicket[],
  config: SelectionConfig,
  asOf: Date,
): SelectionResult {
  const byKey = new Map<string, BugTicket>();
  for (const ticket of tickets) {
    if (!byKey.has(ticket.key)) {
      byKey.set(ticket.key, ticket);
    }
  }

  const controlKeys = new Set(config.controls.map((control) => control.key));
  const eligible: BugTicket[] = [];
  const excluded: Exclusion[] = [];
  for (const key of [...byKey.keys()].sort()) {
    const ticket = byKey.get(key);
    if (ticket === undefined) {
      continue;
    }
    const reason = exclusionReason(ticket, asOf, config.agedDays);
    if (reason) {
      // A control may legitimately be Done or young; the control loop decides
      // whether to include or refuse it, and must not report it twice.
      if (!controlKeys.has(key)) {
        excluded.push({ key, reason });
      }
      continue;
    }
    eligible.push(ticket);
  }

  const strata = new Map<string, BugTicket[]>();
  for (const ticket of eligible) {
    const name = stratumOf(ticket);
    const group = strata.get(name) ?? [];
    group.push(ticket);
    strata.set(name, group);
  }
  for (const group of strata.values()) {
    group.sort((left, right) => {
      const order = stableOrder(left.key, config.seed);
      const other = stableOrder(right.key, config.seed);
      return order < other ? -1 : order > other ? 1 : left.key.localeCompare(right.key);
    });
  }

  const selected: Selection[] = [];
  const orderedStrata = [...strata.keys()].sort();
  let cursor = 0;
  const hasRemaining = (): boolean => [...strata.values()].some((group) => group.length > 0);
  while (selected.length < config.size && orderedStrata.length > 0 && hasRemaining()) {
    const name = orderedStrata[cursor % orderedStrata.length] ?? "Unowned";
    const group = strata.get(name) ?? [];
    if (group.length > 0) {
      const ticket = group.shift();
      if (ticket !== undefined && !controlKeys.has(ticket.key)) {
        selected.push({
          ticket,
          kind: "aged",
          stratum: name,
          ageDays: ageDays(ticket.created, asOf),
        });
      }
    }
    cursor += 1;
  }

  for (const control of config.controls) {
    const ticket = byKey.get(control.key);
    if (ticket === undefined) {
      excluded.push({ key: control.key, reason: "control not present in the corpus" });
      continue;
    }
    const customer = customerReason(ticket);
    if (customer) {
      excluded.push({ key: control.key, reason: `control is customer-linked (${customer})` });
      continue;
    }
    selected.push({
      ticket,
      kind: "control",
      stratum: stratumOf(ticket),
      ageDays: ageDays(ticket.created, asOf),
      controlLabel: control.label,
    });
  }

  return { selected, excluded, eligible: eligible.length };
}
