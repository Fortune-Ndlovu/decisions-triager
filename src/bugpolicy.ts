// Evidence-first disposition policy.
//
// The adjudicator does not get to assert a confidence number. It supplies
// claims with citations; this module grades the evidence, applies the close
// thresholds, and downgrades anything that fails a gate. A close proposal must
// survive four checks: direct evidence, a reviewed second pass, a supported
// disposition-specific proof, and a non-customer, not-already-Done ticket.
//
// There is no write path here. A packet carries an action name; nothing in this
// module can comment, transition, or link.
import type { BugTicket } from "./bugmodel.ts";
import type { Assessment, Evidence } from "./bugassessment.ts";
import { EVIDENCE_STRENGTHS } from "./bugassessment.ts";
import { DUPLICATE_CLOSE_THRESHOLD, type DuplicateCandidate } from "./bugduplicates.ts";

export const POLICY_VERSION = 1;
export const FIXED_CLOSE_THRESHOLD = 0.8;
export const OBSOLETE_CLOSE_THRESHOLD = 0.8;
export const COMMENT_THRESHOLD = 0.6;

export type Disposition =
  | "duplicate"
  | "already_fixed"
  | "still_valid"
  | "no_longer_valid"
  | "needs_repro"
  | "unclear";

export type Action =
  | "propose_close_duplicate"
  | "propose_close_fixed"
  | "propose_close_obsolete"
  | "comment_only"
  | "keep_open"
  | "needs_repro"
  | "unclear";

export const DISPOSITIONS: readonly Disposition[] = [
  "duplicate",
  "already_fixed",
  "still_valid",
  "no_longer_valid",
  "needs_repro",
  "unclear",
];

const DISPOSITION_SET = new Set<string>(DISPOSITIONS);

export const CLOSE_ACTIONS: readonly Action[] = [
  "propose_close_duplicate",
  "propose_close_fixed",
  "propose_close_obsolete",
];

const CLOSE_ACTION_SET = new Set<Action>(CLOSE_ACTIONS);

export function isCloseAction(action: Action): boolean {
  return CLOSE_ACTION_SET.has(action);
}

export interface Packet {
  key: string;
  summary: string;
  status: string;
  disposition: Disposition;
  confidence: number;
  confidenceBasis: string[];
  action: Action;
  recommendedStep: string;
  target: string;
  explicitDuplicateLink: boolean;
  evidence: Evidence[];
  duplicateCandidates: DuplicateCandidate[];
  gaps: string[];
  notes: string;
  customerSignals: string[];
  currentRelease: string;
  independentPasses: number;
  agreement: boolean;
  proposedComment: string;
  verificationErrors: string[];
  invalidEvidence: Record<string, unknown>[];
  policyVersion: number;
}

export function evidenceConfidence(evidence: readonly Evidence[]): {
  confidence: number;
  basis: string[];
} {
  if (evidence.length === 0) {
    return { confidence: 0, basis: ["no valid evidence"] };
  }
  let best = 0;
  let bestStrength: Evidence["strength"] = "supporting";
  const independent = new Set<string>();
  for (const item of evidence) {
    const weight = EVIDENCE_STRENGTHS[item.strength];
    if (weight > best) {
      best = weight;
      bestStrength = item.strength;
    }
    if (item.strength === "direct" || item.strength === "strong") {
      independent.add(item.ref);
    }
  }
  const bonus = Math.min(0.08, 0.04 * Math.max(0, independent.size - 1));
  const basis = [`best evidence: ${bestStrength}`];
  if (independent.size > 1) {
    basis.push(`${independent.size} independent strong/direct citations`);
  }
  return { confidence: Math.min(0.98, best + bonus), basis };
}

function reviewed(passes: number, agree: boolean): boolean {
  return passes >= 2 && agree;
}

interface GateResult {
  allowed: boolean;
  reasons: string[];
}

function closeGate(
  ticket: BugTicket,
  confidence: number,
  threshold: number,
  evidence: readonly Evidence[],
  passes: number,
  agree: boolean,
): GateResult {
  const reasons: string[] = [];
  if (ticket.customerSignals.length > 0) {
    reasons.push("customer-linked ticket; close is never proposed");
  }
  if (confidence < threshold) {
    reasons.push(`confidence ${confidence.toFixed(2)} below ${threshold.toFixed(2)}`);
  }
  if (!evidence.some((item) => item.strength === "direct")) {
    reasons.push("no direct evidence");
  }
  if (!reviewed(passes, agree)) {
    reasons.push("second independent pass missing or disagreed");
  }
  return { allowed: reasons.length === 0, reasons };
}

function evidenceList(evidence: readonly Evidence[]): string[] {
  return evidence.map((item) => `- ${item.why} (${item.ref})`);
}

function duplicateComment(
  assessment: Assessment,
  candidate: DuplicateCandidate | undefined,
): string {
  const lines = [`Triaged as a duplicate of ${assessment.duplicateOf}.`];
  if (candidate) {
    lines.push(
      `The summaries and error signatures align at a lexical score of ` +
        `${candidate.score.toFixed(2)}; a reviewer confirmed the same failure.`,
    );
  }
  lines.push("", "Evidence:", ...evidenceList(assessment.evidence), "");
  lines.push(
    "If this report describes a different failure, reopen with the distinct error " +
      "signature and the environment where it occurs.",
  );
  return lines.join("\n");
}

function duplicateHintComment(
  assessment: Assessment,
  candidate: DuplicateCandidate | undefined,
): string {
  const lines = [
    `Possible duplicate of ${assessment.duplicateOf}. This is a triage hint, not a close proposal.`,
  ];
  if (candidate) {
    lines.push(
      `Deterministic similarity is ${candidate.score.toFixed(2)}, below the ` +
        `${DUPLICATE_CLOSE_THRESHOLD.toFixed(2)} close floor, so a reviewer must confirm the ` +
        `match before any disposition.`,
    );
  } else {
    lines.push(
      "The candidate is not in the retrieved set, so a reviewer must confirm the match " +
        "before any disposition.",
    );
  }
  lines.push("", "Evidence:", ...evidenceList(assessment.evidence));
  return lines.join("\n");
}

function fixedComment(assessment: Assessment): string {
  const artifact = assessment.fixPr || assessment.fixCommit;
  const lines = [`The reported behavior is fixed by ${artifact}.`];
  if (assessment.fixRelease) {
    lines.push(`The fix is released in ${assessment.fixRelease}.`);
  }
  lines.push("", "Evidence:", ...evidenceList(assessment.evidence), "");
  lines.push(
    "Closing as fixed. If the behavior still occurs on a supported release, reopen with the " +
      "version and reproduction steps.",
  );
  return lines.join("\n");
}

function obsoleteComment(assessment: Assessment): string {
  return [
    "This behavior no longer applies to the current product.",
    "",
    "Evidence:",
    ...evidenceList(assessment.evidence),
    "",
    "Closing as no longer valid. Reopen with a current reproduction if the problem returns " +
      "on a supported release.",
  ].join("\n");
}

function obsoleteHintComment(assessment: Assessment): string {
  return [
    "Possible no-longer-valid report. The evidence does not meet the close floor, so this is " +
      "a comment only.",
    "",
    "Evidence:",
    ...evidenceList(assessment.evidence),
    "",
    "A reviewer must confirm the removal or failed reproduction before closing.",
  ].join("\n");
}

export function needsReproComment(currentRelease: string): string {
  return (
    "We are re-checking aged bug reports against the current release. This report does not " +
    `contain enough information to confirm whether it still occurs on ${currentRelease}.\n\n` +
    "Please add:\n" +
    "- the exact RHDH version and installation method\n" +
    "- the environment (OpenShift/Kubernetes version, operator or Helm chart)\n" +
    "- minimal reproduction steps\n" +
    "- the full error message or stack trace\n\n" +
    "If the issue is no longer reproducible, say so and we will close it with that evidence."
  );
}

function stillValidComment(assessment: Assessment, currentRelease: string): string {
  const lines = [
    `Re-checked against ${assessment.reproRelease || currentRelease}: this is still a real problem.`,
  ];
  if (assessment.reproResult) {
    lines.push(`Reproduction result: ${assessment.reproResult}.`);
  }
  lines.push("", "Evidence:", ...evidenceList(assessment.evidence), "");
  lines.push(
    "Recommendation: keep this open and assign it to the owning team. This triage does not " +
      "propose a close.",
  );
  return lines.join("\n");
}

interface DuplicateSupport {
  candidate: DuplicateCandidate | undefined;
  explicitLink: boolean;
}

/**
 * Jira's Duplicate link is directional: outward is "duplicates" (this ticket is
 * the duplicate), inward is "is duplicated by" (the linked ticket is the
 * duplicate, so this one is canonical). Only an outward link supports closing
 * the queried ticket. An unknown direction fails closed.
 */
function duplicateSupport(
  ticket: BugTicket,
  assessment: Assessment,
  candidates: readonly DuplicateCandidate[],
): DuplicateSupport {
  const candidate = candidates.find((item) => item.key === assessment.duplicateOf);
  const explicitLink = ticket.links.some(
    (link) =>
      link.key === assessment.duplicateOf &&
      link.type.toLowerCase().includes("duplicate") &&
      link.direction === "outward",
  );
  return { candidate, explicitLink };
}

function basePacket(
  ticket: BugTicket,
  candidates: readonly DuplicateCandidate[],
  currentRelease: string,
): Packet {
  return {
    key: ticket.key,
    summary: ticket.summary,
    status: ticket.status,
    disposition: "unclear",
    confidence: 0,
    confidenceBasis: [],
    action: "unclear",
    recommendedStep: "",
    target: "",
    explicitDuplicateLink: false,
    evidence: [],
    duplicateCandidates: [...candidates],
    gaps: [],
    notes: "",
    customerSignals: [...ticket.customerSignals],
    currentRelease,
    independentPasses: 0,
    agreement: false,
    proposedComment: "",
    verificationErrors: [],
    invalidEvidence: [],
    policyVersion: POLICY_VERSION,
  };
}

/** Turn a ticket, its duplicate candidates, and an optional assessment into one packet. */
export function evaluate(
  ticket: BugTicket,
  candidates: readonly DuplicateCandidate[],
  assessment: Assessment | undefined,
  currentRelease: string,
): Packet {
  if (!assessment?.disposition) {
    return {
      ...basePacket(ticket, candidates, currentRelease),
      disposition: "unclear",
      confidence: 0,
      confidenceBasis: ["no adjudication supplied"],
      action: "needs_repro",
      recommendedStep: "Ask for a current-release reproduction before any decision.",
      proposedComment: needsReproComment(currentRelease),
    };
  }

  if (!DISPOSITION_SET.has(assessment.disposition)) {
    return {
      ...basePacket(ticket, candidates, currentRelease),
      disposition: "unclear",
      confidence: 0,
      confidenceBasis: [`unknown disposition '${assessment.disposition}'`],
      action: "needs_repro",
      recommendedStep: "Correct the assessment disposition and rerun.",
      evidence: assessment.evidence,
      invalidEvidence: assessment.invalidEvidence,
    };
  }

  const { confidence: graded, basis } = evidenceConfidence(assessment.evidence);
  let confidence = graded;
  const gaps: string[] = [];
  if (assessment.invalidEvidence.length > 0) {
    gaps.push(`${assessment.invalidEvidence.length} evidence item(s) lacked a citation`);
  }
  if (ticket.customerSignals.length > 0) {
    gaps.push("customer-linked; close is disabled");
  }

  let disposition = assessment.disposition as Disposition;
  let action: Action = "comment_only";
  let recommended = "Review the evidence and decide the next step.";
  let comment = "";
  let explicitDuplicateLink = false;

  if (disposition === "duplicate") {
    const support = duplicateSupport(ticket, assessment, candidates);
    const { candidate } = support;
    explicitDuplicateLink = support.explicitLink;
    let matchScore = candidate?.score ?? 0;
    if (explicitDuplicateLink) {
      matchScore = Math.max(matchScore, 0.9);
      basis.push("Jira Duplicate link present");
    }
    if (candidate) {
      basis.push(`duplicate candidate ${candidate.key} scored ${candidate.score.toFixed(2)}`);
    }
    if (!assessment.duplicateOf) {
      gaps.push("duplicateOf is missing");
      disposition = "unclear";
      action = "needs_repro";
      recommended = "Name the duplicate target or downgrade the finding.";
      comment = needsReproComment(currentRelease);
    } else {
      confidence = Math.min(confidence, matchScore);
      if (candidate === undefined && !explicitDuplicateLink) {
        gaps.push("duplicate target is not in the candidate set and has no Duplicate link");
      } else if (matchScore < DUPLICATE_CLOSE_THRESHOLD) {
        gaps.push(
          `duplicate match ${matchScore.toFixed(2)} is below the ` +
            `${DUPLICATE_CLOSE_THRESHOLD.toFixed(2)} close floor; only a comment is proposed`,
        );
      }
      const gate = closeGate(
        ticket,
        confidence,
        DUPLICATE_CLOSE_THRESHOLD,
        assessment.evidence,
        assessment.independentPasses,
        assessment.agreement,
      );
      if (gate.allowed && matchScore >= DUPLICATE_CLOSE_THRESHOLD) {
        action = "propose_close_duplicate";
        recommended = `Close as duplicate of ${assessment.duplicateOf}.`;
        comment = assessment.comment || duplicateComment(assessment, candidate);
      } else {
        gaps.push(...gate.reasons);
        action = confidence >= COMMENT_THRESHOLD ? "comment_only" : "needs_repro";
        recommended = `Comment that this may duplicate ${assessment.duplicateOf}; do not close.`;
        comment = duplicateHintComment(assessment, candidate);
      }
    }
  } else if (disposition === "already_fixed") {
    const artifact = assessment.fixPr || assessment.fixCommit;
    if (!artifact) {
      gaps.push("no fix PR or commit");
    }
    if (!assessment.fixRelease) {
      gaps.push("no release carrying the fix");
    }
    if (!assessment.fixReleased) {
      gaps.push("fix is not confirmed released");
    }
    const gate = closeGate(
      ticket,
      confidence,
      FIXED_CLOSE_THRESHOLD,
      assessment.evidence,
      assessment.independentPasses,
      assessment.agreement,
    );
    const allowed =
      gate.allowed && artifact !== "" && assessment.fixReleased && assessment.fixRelease !== "";
    if (allowed) {
      action = "propose_close_fixed";
      const releaseNote = assessment.fixRelease ? `, released in ${assessment.fixRelease}.` : ".";
      recommended = `Close as fixed by ${artifact}${releaseNote}`;
      comment = assessment.comment || fixedComment(assessment);
    } else {
      gaps.push(...gate.reasons);
      action = confidence >= COMMENT_THRESHOLD ? "comment_only" : "needs_repro";
      recommended = "Comment with the fix lead; keep open until the fix is on a supported release.";
      const releaseText = assessment.fixRelease
        ? ` Reported fixed in ${assessment.fixRelease}.`
        : " No release is confirmed.";
      comment =
        `Possible fix: ${artifact || "unknown artifact"}.${releaseText}` +
        "\n\nDo not close until the fix is verified on a supported release.";
    }
  } else if (disposition === "no_longer_valid") {
    const gate = closeGate(
      ticket,
      confidence,
      OBSOLETE_CLOSE_THRESHOLD,
      assessment.evidence,
      assessment.independentPasses,
      assessment.agreement,
    );
    const directTypes = new Set(
      assessment.evidence.filter((item) => item.strength === "direct").map((item) => item.type),
    );
    const proven = ["code", "doc", "repro", "release_note"].some((type) =>
      directTypes.has(type as never),
    );
    if (!proven) {
      gaps.push("no direct code, doc, repro, or release-note evidence");
    }
    if (gate.allowed && proven) {
      action = "propose_close_obsolete";
      recommended = "Close as no longer valid; cite the removal or failed reproduction.";
      comment = assessment.comment || obsoleteComment(assessment);
    } else {
      gaps.push(...gate.reasons);
      action = confidence >= COMMENT_THRESHOLD ? "comment_only" : "needs_repro";
      recommended = "Comment only; the evidence does not prove the behavior is gone.";
      comment = obsoleteHintComment(assessment);
    }
  } else if (disposition === "still_valid") {
    action = "keep_open";
    recommended =
      "Keep open and assign to the owning team; add current-release reproduction detail to " +
      "the ticket.";
    if (assessment.evidence.length === 0) {
      gaps.push("still-valid claim has no citation");
      confidence = 0;
      action = "needs_repro";
      recommended = "Ask for a reproduction; do not keep the claim uncited.";
      comment = needsReproComment(currentRelease);
    } else {
      comment = assessment.comment || stillValidComment(assessment, currentRelease);
    }
  } else if (disposition === "needs_repro") {
    action = "needs_repro";
    recommended = "Ask for the exact version, environment, and reproduction steps.";
    comment = assessment.comment || needsReproComment(currentRelease);
  } else {
    action = "unclear";
    recommended = "Do not act; collect more evidence first.";
    if (assessment.evidence.length > 0) {
      const { confidence: regradedConfidence, basis: regradedBasis } = evidenceConfidence(
        assessment.evidence,
      );
      confidence = regradedConfidence;
      basis.splice(0, basis.length, ...regradedBasis);
    }
    ({ comment } = assessment);
  }

  const packet: Packet = {
    ...basePacket(ticket, candidates, currentRelease),
    disposition,
    confidence,
    confidenceBasis: basis,
    action,
    recommendedStep: recommended,
    target: disposition === "duplicate" ? assessment.duplicateOf : "",
    explicitDuplicateLink,
    evidence: assessment.evidence,
    gaps,
    notes: assessment.notes,
    independentPasses: assessment.independentPasses,
    agreement: assessment.agreement,
    proposedComment: comment,
    invalidEvidence: assessment.invalidEvidence,
  };

  packet.verificationErrors = verifyPacket(packet, ticket);
  if (packet.verificationErrors.length > 0) {
    // Fail closed: a close proposal that cannot be verified becomes a comment.
    if (isCloseAction(packet.action)) {
      packet.action = "comment_only";
      packet.recommendedStep =
        "Verifier rejected the close proposal; keep open and review the evidence.";
    }
    packet.confidenceBasis.push("verifier downgraded the action");
  }

  if (ticket.isDone && isCloseAction(packet.action)) {
    // A control may be an already-closed ticket. Classify it, but never propose
    // closing something that is already Done.
    packet.action = "comment_only";
    packet.gaps.push("ticket is already Done; close action suppressed");
    packet.recommendedStep =
      "Already closed. Use the classification as a control check; no close is proposed.";
    packet.proposedComment =
      assessment.comment ||
      "This ticket is already closed. The triage classification is recorded for comparison " +
        "only; no action is proposed.";
  }
  return packet;
}

function thresholdFor(action: Action): number {
  if (action === "propose_close_duplicate") {
    return DUPLICATE_CLOSE_THRESHOLD;
  }
  if (action === "propose_close_fixed") {
    return FIXED_CLOSE_THRESHOLD;
  }
  if (action === "propose_close_obsolete") {
    return OBSOLETE_CLOSE_THRESHOLD;
  }
  return 0;
}

/** Re-check a packet against the close gate. Returns every violation. */
export function verifyPacket(packet: Packet, ticket: BugTicket): string[] {
  const errors: string[] = [];
  if (!isCloseAction(packet.action)) {
    return errors;
  }
  if (ticket.customerSignals.length > 0 || packet.customerSignals.length > 0) {
    errors.push("customer-linked ticket cannot receive a close proposal");
  }
  if (packet.evidence.length === 0) {
    errors.push("close proposal has no evidence");
  }
  if (!packet.evidence.some((item) => item.strength === "direct")) {
    errors.push("close proposal has no direct evidence");
  }
  if (!reviewed(packet.independentPasses, packet.agreement)) {
    errors.push("close proposal lacks an agreeing second independent pass");
  }
  if (packet.action === "propose_close_duplicate") {
    if (!packet.target) {
      errors.push("duplicate close has no target key");
    }
    const strongCandidate = packet.duplicateCandidates.some(
      (candidate) =>
        candidate.key === packet.target && candidate.score >= DUPLICATE_CLOSE_THRESHOLD,
    );
    const cited = packet.evidence.some(
      (item) => item.type === "jira" && item.strength === "direct" && item.ref === packet.target,
    );
    if (!packet.explicitDuplicateLink && !strongCandidate) {
      errors.push("duplicate close needs a >=0.85 candidate or an explicit Duplicate link");
    }
    if (!cited && !packet.explicitDuplicateLink) {
      errors.push("duplicate close has no direct citation of the target");
    }
  }
  if (packet.action === "propose_close_fixed") {
    const cited = packet.evidence.some(
      (item) => (item.type === "pr" || item.type === "commit") && item.strength === "direct",
    );
    if (!cited) {
      errors.push("fixed close has no direct PR or commit citation");
    }
  }
  if (packet.action === "propose_close_obsolete") {
    const cited = packet.evidence.some(
      (item) =>
        ["code", "doc", "repro", "release_note"].includes(item.type) && item.strength === "direct",
    );
    if (!cited) {
      errors.push("obsolete close has no direct code, doc, repro, or release-note citation");
    }
  }
  if (packet.confidence < thresholdFor(packet.action)) {
    errors.push(
      `confidence ${packet.confidence.toFixed(2)} below ${thresholdFor(packet.action).toFixed(2)}`,
    );
  }
  return errors;
}

export function countBy<T extends string>(values: readonly T[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of [...values].sort()) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}
