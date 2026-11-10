// Adjudication input: an assessment is what a reviewer or a two-pass agent
// claims about a ticket. It supplies claims with citations, never a confidence
// number — policy derives that from evidence strength.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isRecord } from "./normalize.ts";

export type EvidenceType =
  | "jira"
  | "pr"
  | "commit"
  | "release_note"
  | "code"
  | "doc"
  | "repro"
  | "comment";

export type EvidenceStrength = "direct" | "strong" | "supporting";

export interface Evidence {
  type: EvidenceType;
  ref: string;
  why: string;
  strength: EvidenceStrength;
}

export const EVIDENCE_STRENGTHS: Record<EvidenceStrength, number> = {
  direct: 1,
  strong: 0.8,
  supporting: 0.5,
};

export const EVIDENCE_TYPES: readonly EvidenceType[] = [
  "jira",
  "pr",
  "commit",
  "release_note",
  "code",
  "doc",
  "repro",
  "comment",
];

const EVIDENCE_TYPE_SET = new Set<string>(EVIDENCE_TYPES);
const STRENGTH_SET = new Set<string>(["direct", "strong", "supporting"]);

export interface Assessment {
  key: string;
  disposition: string;
  duplicateOf: string;
  evidence: Evidence[];
  fixPr: string;
  fixCommit: string;
  fixRelease: string;
  fixReleased: boolean;
  reproResult: string;
  reproRelease: string;
  notes: string;
  comment: string;
  independentPasses: number;
  agreement: boolean;
  invalidEvidence: Record<string, unknown>[];
}

export class AssessmentError extends Error {}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseEvidence(item: unknown): Evidence | null {
  if (!isRecord(item)) {
    return null;
  }
  const type = text(item.type).toLowerCase();
  const ref = text(item.ref);
  const why = text(item.why);
  const strength = (text(item.strength) || "supporting").toLowerCase();
  if (!EVIDENCE_TYPE_SET.has(type) || !ref || !why || !STRENGTH_SET.has(strength)) {
    return null;
  }
  return {
    type: type as EvidenceType,
    ref,
    why,
    strength: strength as EvidenceStrength,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function parseAssessment(document: unknown): Assessment {
  if (!isRecord(document)) {
    throw new AssessmentError("assessment must be an object");
  }
  const key = text(document.key);
  if (!key) {
    throw new AssessmentError("assessment has no key");
  }

  const evidence: Evidence[] = [];
  const invalid: Record<string, unknown>[] = [];
  const rawEvidence = Array.isArray(document.evidence) ? document.evidence : [];
  for (const item of rawEvidence) {
    const parsed = parseEvidence(item);
    if (parsed === null) {
      invalid.push(isRecord(item) ? { ...item } : { value: String(item) });
      continue;
    }
    evidence.push(parsed);
  }

  const fix = asRecord(document.fix);
  const repro = asRecord(document.repro);
  const review = asRecord(document.review);
  const passesRaw = review.independentPasses ?? document.independentPasses ?? 0;
  const passes =
    typeof passesRaw === "number" && Number.isFinite(passesRaw) ? Math.trunc(passesRaw) : 0;

  return {
    key,
    disposition: text(document.disposition).toLowerCase(),
    duplicateOf: text(document.duplicateOf),
    evidence,
    fixPr: text(fix.pr),
    fixCommit: text(fix.commit),
    fixRelease: text(fix.release),
    fixReleased: fix.released === true,
    reproResult: text(repro.result).toLowerCase(),
    reproRelease: text(repro.release),
    notes: text(document.notes),
    comment: text(document.comment),
    independentPasses: passes,
    agreement: review.agree === true || document.agree === true,
    invalidEvidence: invalid,
  };
}

/**
 * Read `KEY.json` files from a directory. A malformed file is an error, not a
 * silent skip: an assessment that cannot be parsed must not become a packet
 * that looks adjudicated.
 */
export function loadAssessments(directory: string): Map<string, Assessment> {
  const assessments = new Map<string, Assessment>();
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return assessments;
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const path = join(directory, entry);
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(path, "utf-8"));
    } catch (error) {
      throw new AssessmentError(`${basename(path)}: ${String(error)}`);
    }
    const assessment = parseAssessment(document);
    if (assessment.key !== basename(entry, ".json")) {
      throw new AssessmentError(
        `${basename(path)}: key '${assessment.key}' does not match the filename`,
      );
    }
    assessments.set(assessment.key, assessment);
  }
  return assessments;
}
