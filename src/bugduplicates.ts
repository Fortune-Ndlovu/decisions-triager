// Deterministic duplicate candidate generation and lexical scoring.
//
// This is the retrieval half of the duplicate check. It never declares a
// duplicate on its own: it ranks candidates and explains the score, and the
// assessment plus policy decide whether the evidence is strong enough to
// propose a close. The score is the auditable floor, not the verdict.
import type { BugTicket } from "./bugmodel.ts";

export const DUPLICATE_CLOSE_THRESHOLD = 0.85;
export const DUPLICATE_HINT_THRESHOLD = 0.7;
export const MIN_CANDIDATE_SCORE = 0.35;
/** Candidates kept per ticket after merging every retrieval source. */
export const CANDIDATE_LIMIT = 3;
/** JQL terms used for the bounded per-ticket candidate search. */
export const CANDIDATE_MAX_TERMS = 4;

const STOPWORDS = new Set([
  "a",
  "about",
  "after",
  "all",
  "also",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "but",
  "by",
  "can",
  "cannot",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "done",
  "for",
  "from",
  "get",
  "gets",
  "getting",
  "had",
  "has",
  "have",
  "having",
  "he",
  "her",
  "here",
  "him",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "like",
  "may",
  "me",
  "might",
  "more",
  "most",
  "must",
  "my",
  "no",
  "not",
  "now",
  "of",
  "on",
  "once",
  "only",
  "or",
  "other",
  "our",
  "out",
  "over",
  "own",
  "same",
  "she",
  "should",
  "so",
  "some",
  "such",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "to",
  "too",
  "under",
  "until",
  "up",
  "very",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

const ERROR_MARKERS = [
  "error",
  "exception",
  "traceback",
  "failed",
  "failure",
  "fails",
  "panic",
  "segfault",
  "timeout",
  "timed out",
  "refused",
  "denied",
  "not found",
  "unable",
  "cannot",
  "crash",
  "warning",
  "cve-",
];

const TOKEN_RE = /[a-z0-9][a-z0-9_.@/:-]*[a-z0-9]|[a-z0-9]/giu;
const QUOTED_RE = /["'`]([^"'`]{3,80})["'`]/gu;
const SPECIFIC_RE = /\d{3,}|[A-Z][a-z]+(?:Error|Exception)|\//u;

export function normalizeToken(raw: string): string {
  let token = raw.replaceAll(/^[.,;:()[\]{}<>!?"'`]+|[.,;:()[\]{}<>!?"'`]+$/gu, "").toLowerCase();
  if (token.endsWith("'s")) {
    token = token.slice(0, -2);
  }
  if (
    token.length > 4 &&
    token.endsWith("s") &&
    !token.endsWith("ss") &&
    !token.endsWith("is") &&
    !token.endsWith("us")
  ) {
    token = token.slice(0, -1);
  }
  return token;
}

export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  if (!text) {
    return tokens;
  }
  for (const raw of text.match(TOKEN_RE) ?? []) {
    const token = normalizeToken(raw);
    if (token.length < 3 || STOPWORDS.has(token)) {
      continue;
    }
    tokens.add(token);
  }
  return tokens;
}

export function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) {
      shared += 1;
    }
  }
  return shared / (left.size + right.size - shared);
}

export function containment(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) {
      shared += 1;
    }
  }
  return shared / Math.min(left.size, right.size);
}

/**
 * Tokens from error-bearing lines plus quoted strings. A stack trace,
 * exception name, HTTP status, CVE id, or quoted error is the strongest
 * affordable duplicate signal; keeping only those stops prose from inflating
 * the score.
 */
export function extractSignatures(text: string): Set<string> {
  const signatures = new Set<string>();
  if (!text) {
    return signatures;
  }
  for (const line of text.split("\n")) {
    const lowered = line.toLowerCase();
    const hasMarker = ERROR_MARKERS.some((term) => lowered.includes(term));
    if (!hasMarker && !SPECIFIC_RE.test(line)) {
      continue;
    }
    for (const raw of line.match(TOKEN_RE) ?? []) {
      const token = normalizeToken(raw);
      if (token.length >= 3 && !STOPWORDS.has(token)) {
        signatures.add(token);
      }
    }
  }
  for (const quoted of text.match(QUOTED_RE) ?? []) {
    for (const raw of quoted.match(TOKEN_RE) ?? []) {
      const token = normalizeToken(raw);
      if (token.length >= 3 && !STOPWORDS.has(token)) {
        signatures.add(token);
      }
    }
  }
  return signatures;
}

export type LinkRelationship = "duplicate" | "reverse-duplicate" | "related" | "";

/**
 * Describe the Jira link between the query and a candidate.
 *
 * `duplicate` means the query carries an outward Duplicate link to the
 * candidate, so the query is the duplicate. `reverse-duplicate` means the
 * candidate duplicates the query, so the query is the canonical report and
 * must never be closed by this path.
 */
export function linkRelationship(query: BugTicket, candidate: BugTicket): LinkRelationship {
  for (const link of query.links) {
    if (link.key !== candidate.key) {
      continue;
    }
    if (link.type.toLowerCase().includes("duplicate")) {
      return link.direction === "outward" ? "duplicate" : "reverse-duplicate";
    }
    return "related";
  }
  for (const link of candidate.links) {
    if (link.key !== query.key) {
      continue;
    }
    if (link.type.toLowerCase().includes("duplicate") && link.direction === "outward") {
      return "reverse-duplicate";
    }
    return "related";
  }
  return "";
}

export interface DuplicateSignals {
  summaryJaccard: number;
  summaryContainment: number;
  descriptionJaccard: number;
  signatureJaccard: number;
  componentJaccard: number;
}

export interface DuplicateCandidate {
  key: string;
  summary: string;
  status: string;
  score: number;
  components: string[];
  signals: DuplicateSignals;
  reasons: string[];
}

/** True only when both timestamps parse and the candidate is strictly later. */
function createdAfter(candidate: string, base: string): boolean {
  const candidateTime = Date.parse(candidate);
  const baseTime = Date.parse(base);
  return Number.isFinite(candidateTime) && Number.isFinite(baseTime) && candidateTime > baseTime;
}

export function scoreCandidate(query: BugTicket, candidate: BugTicket): DuplicateCandidate {
  const querySummary = tokenize(query.summary);
  const candidateSummary = tokenize(candidate.summary);
  const queryDescription = tokenize(query.description);
  const candidateDescription = tokenize(candidate.description);
  const querySignatures = extractSignatures(query.searchText);
  const candidateSignatures = extractSignatures(candidate.searchText);

  const signals: DuplicateSignals = {
    summaryJaccard: jaccard(querySummary, candidateSummary),
    summaryContainment: containment(querySummary, candidateSummary),
    descriptionJaccard: jaccard(queryDescription, candidateDescription),
    signatureJaccard: jaccard(querySignatures, candidateSignatures),
    componentJaccard: jaccard(new Set(query.components), new Set(candidate.components)),
  };

  // Renormalize over the signals both tickets can supply. A missing
  // description should weaken the evidence, not manufacture a low score for a
  // real match.
  const weights: Record<keyof DuplicateSignals, number> = {
    summaryJaccard: 0.3,
    summaryContainment: 0.15,
    descriptionJaccard: 0.2,
    signatureJaccard: 0.25,
    componentJaccard: 0.1,
  };
  const available: Record<keyof DuplicateSignals, boolean> = {
    summaryJaccard: querySummary.size > 0 && candidateSummary.size > 0,
    summaryContainment: querySummary.size > 0 && candidateSummary.size > 0,
    descriptionJaccard: queryDescription.size > 0 && candidateDescription.size > 0,
    signatureJaccard: querySignatures.size > 0 && candidateSignatures.size > 0,
    componentJaccard: query.components.length > 0 && candidate.components.length > 0,
  };
  let totalWeight = 0;
  let weighted = 0;
  for (const name of Object.keys(weights) as (keyof DuplicateSignals)[]) {
    if (available[name]) {
      totalWeight += weights[name];
      weighted += signals[name] * weights[name];
    }
  }
  let score = totalWeight > 0 ? weighted / totalWeight : 0;

  const reasons: string[] = [];
  if (signals.summaryJaccard >= 0.5) {
    reasons.push("summary shares most content words");
  }
  if (signals.signatureJaccard >= 0.5) {
    reasons.push("error signatures overlap");
  }
  if (signals.componentJaccard >= 0.5) {
    reasons.push("same component");
  }
  const relationship = linkRelationship(query, candidate);
  const reverseDuplicate = relationship === "reverse-duplicate";
  if (relationship === "duplicate") {
    score += 0.1;
    reasons.push("outward Duplicate link");
  } else if (reverseDuplicate) {
    reasons.push("candidate duplicates this ticket");
  } else if (relationship === "related") {
    score += 0.02;
    reasons.push("linked issue");
  }
  if (query.reporter && candidate.reporter && query.reporter === candidate.reporter) {
    score += 0.03;
    reasons.push("same reporter");
  }
  if (query.team && candidate.team && query.team === candidate.team) {
    score += 0.02;
    reasons.push("same team");
  }
  if (reasons.length === 0) {
    reasons.push("lexical similarity only");
  }
  // The cap is applied last, after every bonus. The candidate is the duplicate
  // and the query is the canonical report; closing the canonical ticket would
  // be backwards, so this pair must never reach the close floor.
  if (reverseDuplicate) {
    score = Math.min(score, DUPLICATE_CLOSE_THRESHOLD - 0.01);
  }
  // Duplicate targets are the older reports. A newer candidate can still be a
  // useful hint, but closing an aged ticket as a duplicate of a younger one
  // usually closes the canonical report; keep that pair under the floor.
  if (!reverseDuplicate && createdAfter(candidate.created, query.created)) {
    score = Math.min(score, DUPLICATE_CLOSE_THRESHOLD - 0.01);
    reasons.push("candidate is newer than this ticket");
  }

  return {
    key: candidate.key,
    summary: candidate.summary,
    status: candidate.status,
    score: Math.min(0.99, Math.max(0, score)),
    components: [...candidate.components],
    signals,
    reasons,
  };
}

export function rankCandidates(
  query: BugTicket,
  corpus: readonly BugTicket[],
  limit = CANDIDATE_LIMIT,
  minScore = MIN_CANDIDATE_SCORE,
): DuplicateCandidate[] {
  const scored: DuplicateCandidate[] = [];
  for (const candidate of corpus) {
    if (candidate.key === query.key) {
      continue;
    }
    const result = scoreCandidate(query, candidate);
    if (result.score >= minScore) {
      scored.push(result);
    }
  }
  scored.sort((left, right) =>
    right.score === left.score ? left.key.localeCompare(right.key) : right.score - left.score,
  );
  return scored.slice(0, limit);
}

export function candidateThreshold(score: number): string {
  if (score >= DUPLICATE_CLOSE_THRESHOLD) {
    return "propose-close-eligible";
  }
  if (score >= DUPLICATE_HINT_THRESHOLD) {
    return "comment-only";
  }
  return "below-threshold";
}

/** A sanitized JQL word: lowercase alphanumerics only, no stopwords. */
function jqlWord(raw: string): string {
  const word = raw.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "");
  return word.length >= 3 && !STOPWORDS.has(word) ? word : "";
}

/**
 * Terms for the bounded candidate search: sanitized words from the summary
 * only.
 *
 * Tuned against redhat.atlassian.net: prose from the summary matched the
 * real older duplicates, while error-signature terms either matched nothing
 * or matched 50 unrelated tickets. Description text was not needed.
 */
export function candidateTerms(ticket: BugTicket, maxTerms = CANDIDATE_MAX_TERMS): string[] {
  const terms: string[] = [];
  for (const token of tokenize(ticket.summary)) {
    const word = jqlWord(token);
    if (word && !terms.includes(word)) {
      terms.push(word);
    }
  }
  return terms.slice(0, maxTerms);
}

/**
 * Bounded per-ticket retrieval, scoped to the ticket's own project.
 *
 * The corpus cap and the corpus JQL cannot hide an older match because this
 * query is independent of both; `created <=` the ticket's own date keeps it
 * to plausible canonical reports. Ordering is Jira's default relevance:
 * measured against real data, `ORDER BY created ASC` returned the 50 oldest
 * matches and pushed the real duplicates out, while relevance found them.
 */
export function candidateJql(ticket: BugTicket, terms: readonly string[]): string {
  const project = ticket.key.split("-")[0] ?? "";
  const clauses = terms.map((term) => `summary ~ "${term}"`);
  const parts: string[] = [];
  if (project) {
    parts.push(`project = ${project}`);
  }
  parts.push(`(${clauses.join(" OR ")})`, `key != ${ticket.key}`);
  const created = /^\d{4}-\d{2}-\d{2}/u.exec(ticket.created)?.[0];
  if (created !== undefined) {
    parts.push(`created <= "${created} 23:59"`);
  }
  return parts.join(" AND ");
}

/** Merge candidate sets by key, keep the best score, and cap the list. */
export function mergeCandidates(
  groups: readonly (readonly DuplicateCandidate[])[],
): DuplicateCandidate[] {
  const best = new Map<string, DuplicateCandidate>();
  for (const group of groups) {
    for (const candidate of group) {
      const existing = best.get(candidate.key);
      if (existing === undefined || candidate.score > existing.score) {
        best.set(candidate.key, candidate);
      }
    }
  }
  return [...best.values()]
    .sort((left, right) =>
      right.score === left.score ? left.key.localeCompare(right.key) : right.score - left.score,
    )
    .slice(0, CANDIDATE_LIMIT);
}
