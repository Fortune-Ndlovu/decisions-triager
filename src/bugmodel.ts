// Aged-bug triage: the ticket shape the disposition path reads. Deliberately
// separate from normalize.ts/Ticket, which serves the Team/component modes:
// this one needs links, comments, versions, age, and customer signals, and it
// must not change the report or write contracts those modes depend on.
import { descriptionText, isRecord } from "./normalize.ts";

export interface BugComment {
  author: string;
  body: string;
  created: string;
}

export type LinkDirection = "outward" | "inward";

export interface BugLink {
  type: string;
  key: string;
  direction: LinkDirection;
  summary: string;
  status: string;
}

export interface BugTicket {
  key: string;
  summary: string;
  description: string;
  status: string;
  statusCategory: string;
  resolution: string;
  created: string;
  updated: string;
  priority: string;
  issueType: string;
  team: string | null;
  components: string[];
  labels: string[];
  fixVersions: string[];
  affectsVersions: string[];
  assignee: string | null;
  reporter: string | null;
  comments: BugComment[];
  links: BugLink[];
  prUrls: string[];
  commitShas: string[];
  customerSignals: string[];
  isDone: boolean;
  /** Summary, description, and comments: the text duplicate scoring reads. */
  searchText: string;
}

export const CUSTOMER_LABELS = ["RHDH-Customer"];
export const CUSTOMER_LINK_PREFIXES = ["RHDHSUPP", "ACCOUNT"];
export const CUSTOMER_FIELD_NAMES = [
  "Customer Name",
  "Customers",
  "Customer Impact",
  "Case Link",
  "Support Case Reference",
  "SFDC cases",
];
export const SUPPORT_KEY_RE = /\bRHDHSUPP-\d+\b/gu;
const PR_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/gu;
const COMMIT_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/commit\/([\da-f]{7,40})/giu;

const DONE_CATEGORIES = new Set(["done", "closed", "complete", "completed"]);
const DONE_STATUSES = new Set(["closed", "done", "resolved", "released"]);

/** The fields the bugs mode needs from Jira, on top of the shared ones. */
export function bugSearchFields(teamField: string): string[] {
  return [
    "summary",
    "description",
    "status",
    "resolution",
    "created",
    "updated",
    "priority",
    "issuetype",
    "components",
    "labels",
    "fixVersions",
    "versions",
    "assignee",
    "reporter",
    "issuelinks",
    "comment",
    "project",
    teamField,
  ];
}

function asText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(asText).filter(Boolean).join("\n");
  }
  if (isRecord(value)) {
    if (typeof value.text === "string") {
      return value.text;
    }
    const parts: string[] = [];
    for (const key of ["content", "body", "value", "description", "comments"]) {
      if (key in value) {
        parts.push(asText(value[key]));
      }
    }
    return parts.filter(Boolean).join("\n");
  }
  return "";
}

function asName(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value)) {
    for (const key of ["name", "value", "displayName", "display_name", "key"]) {
      const candidate = value[key];
      if (typeof candidate === "string" && candidate) {
        return candidate;
      }
      if (isRecord(candidate)) {
        const nested = asName(candidate);
        if (nested) {
          return nested;
        }
      }
    }
    return "";
  }
  if (Array.isArray(value)) {
    return value.map(asName).filter(Boolean).join(", ");
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function asNames(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map(asName).filter(Boolean);
  }
  const name = asName(value);
  return name ? [name] : [];
}

function firstValue(payload: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = payload[key];
    if (
      value !== null &&
      value !== undefined &&
      value !== "" &&
      !(Array.isArray(value) && value.length === 0)
    ) {
      return value;
    }
  }
  return null;
}

function readComments(payload: Record<string, unknown>): BugComment[] {
  let raw = payload.comment ?? payload.comments;
  if (isRecord(raw) && Array.isArray(raw.comments)) {
    raw = raw.comments;
  }
  if (!Array.isArray(raw)) {
    return [];
  }
  const comments: BugComment[] = [];
  for (const item of raw) {
    if (!isRecord(item)) {
      continue;
    }
    comments.push({
      author: asName(item.author) || asName(item.updateAuthor),
      body: asText(item.body),
      created: asText(item.created),
    });
  }
  return comments;
}

function readLinks(payload: Record<string, unknown>): BugLink[] {
  const raw = payload.issuelinks;
  if (!Array.isArray(raw)) {
    return [];
  }
  const links: BugLink[] = [];
  for (const item of raw) {
    if (!isRecord(item)) {
      continue;
    }
    const linkType = asName(item.type) || "related";
    const sides: [LinkDirection, string][] = [
      ["outward", "outwardIssue"],
      ["inward", "inwardIssue"],
    ];
    for (const [direction, name] of sides) {
      const linked = item[name];
      if (!isRecord(linked)) {
        continue;
      }
      const linkedKey = asText(linked.key);
      if (!linkedKey) {
        continue;
      }
      const linkedFields = isRecord(linked.fields) ? linked.fields : {};
      links.push({
        type: linkType,
        key: linkedKey,
        direction,
        summary: asText(linkedFields.summary),
        status: asName(linkedFields.status),
      });
    }
  }
  return links;
}

function collectPrUrls(text: string): string[] {
  return [...new Set(text.match(PR_URL_RE) ?? [])].sort();
}

function collectCommitShas(text: string): string[] {
  const matches = [...text.matchAll(COMMIT_URL_RE)].map((match) => match[1]);
  return [...new Set(matches)].sort();
}

export interface CustomerFieldMap {
  /** customfield id -> human field name, e.g. {"customfield_10746": "Customer Name"} */
  fieldNames?: Record<string, string>;
  /** Extra customfield ids that always mean customer, without a name map. */
  customerFieldIds?: string[];
}

function customerSignals(
  ticketKey: string,
  payload: Record<string, unknown>,
  labels: string[],
  links: BugLink[],
  mapping: CustomerFieldMap,
): string[] {
  const signals: string[] = [];
  const normalizedLabels = new Set(labels.map((label) => label.toLowerCase()));
  for (const label of CUSTOMER_LABELS) {
    if (normalizedLabels.has(label.toLowerCase())) {
      signals.push(`label:${label}`);
    }
  }

  for (const link of links) {
    const prefix = link.key.split("-")[0]?.toUpperCase() ?? "";
    if (CUSTOMER_LINK_PREFIXES.includes(prefix)) {
      signals.push(`link:${link.type}:${link.key}`);
    }
  }

  const namedFields = new Set(CUSTOMER_FIELD_NAMES);
  const forced = new Set(mapping.customerFieldIds ?? []);
  for (const [fieldId, value] of Object.entries(payload)) {
    let fieldName = mapping.fieldNames?.[fieldId] ?? "";
    if (!fieldName && namedFields.has(fieldId)) {
      fieldName = fieldId;
    }
    const isNamed = fieldName !== "" && namedFields.has(fieldName);
    if (!isNamed && !forced.has(fieldId)) {
      continue;
    }
    if (asText(value).trim()) {
      signals.push(`field:${fieldName || fieldId}`);
    }
  }

  const text = JSON.stringify(payload);
  for (const key of [...new Set(text.match(SUPPORT_KEY_RE) ?? [])].sort()) {
    if (key !== ticketKey) {
      signals.push(`text:${key}`);
    }
  }
  return [...new Set(signals)].sort();
}

/**
 * Convert one REST issue into a BugTicket. Permissive about optional shape,
 * strict about identity: a record with no key is a failure, never a skip.
 */
export function normalizeBugIssue(
  issue: unknown,
  teamField: string,
  mapping: CustomerFieldMap = {},
): BugTicket {
  if (!isRecord(issue)) {
    throw new Error("issue must be an object");
  }
  const key = asText(issue.key) || asText(issue.id);
  if (!key) {
    throw new Error("issue has no key");
  }
  const payload = isRecord(issue.fields) ? issue.fields : issue;

  const statusObject = payload.status;
  const status = asName(statusObject);
  const statusCategory =
    isRecord(statusObject) && isRecord(statusObject.category) ? asName(statusObject.category) : "";

  const labels = asNames(payload.labels);
  const links = readLinks(payload);
  const comments = readComments(payload);
  const components = asNames(payload.components);
  const team = asName(firstValue(payload, teamField, "team")) || null;
  let assignee = asName(firstValue(payload, "assignee")) || null;
  if (assignee !== null && ["unassigned", "none"].includes(assignee.toLowerCase())) {
    assignee = null;
  }

  const summary = asText(firstValue(payload, "summary"));
  const description = descriptionText(payload.description);
  const searchText = [summary, description, ...comments.map((comment) => comment.body)].join("\n");
  const serialized = JSON.stringify(issue);

  return {
    key,
    summary,
    description,
    status,
    statusCategory,
    resolution: asName(firstValue(payload, "resolution")),
    created: asText(firstValue(payload, "created")),
    updated: asText(firstValue(payload, "updated")),
    priority: asName(firstValue(payload, "priority")),
    issueType: asName(firstValue(payload, "issuetype", "issue_type")),
    team,
    components,
    labels,
    fixVersions: asNames(firstValue(payload, "fixVersions", "fix_versions")),
    affectsVersions: asNames(firstValue(payload, "versions", "affects_versions")),
    assignee,
    reporter: asName(firstValue(payload, "reporter")) || null,
    comments,
    links,
    prUrls: collectPrUrls(serialized),
    commitShas: collectCommitShas(serialized),
    customerSignals: customerSignals(key, payload, labels, links, mapping),
    isDone:
      DONE_CATEGORIES.has(statusCategory.toLowerCase()) || DONE_STATUSES.has(status.toLowerCase()),
    searchText,
  };
}

/** Parse the ISO-8601 forms Jira emits, including the +0000 offset. */
export function parseTimestamp(value: string): Date | null {
  if (!value) {
    return null;
  }
  let text = value.trim();
  if (text.endsWith("Z")) {
    text = `${text.slice(0, -1)}+00:00`;
  }
  if (/[+-]\d{4}$/u.test(text)) {
    text = `${text.slice(0, -5)}${text.slice(-5, -2)}:${text.slice(-2)}`;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function ageDays(created: string, asOf: Date = new Date()): number | null {
  const createdAt = parseTimestamp(created);
  if (createdAt === null) {
    return null;
  }
  const millis = asOf.getTime() - createdAt.getTime();
  return Math.max(0, Math.floor(millis / 86_400_000));
}
