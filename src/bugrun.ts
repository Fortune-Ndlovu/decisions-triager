// Bug-triage orchestration: fetch the open corpus, select a deterministic
// sample, rank duplicate candidates, grade the supplied assessments, and write
// local artifacts. Read-only by construction: the only external calls are
// JQL searches.
import type { Config } from "./config.ts";
import type { JiraClient } from "./jira.ts";
import {
  bugSearchFields,
  normalizeBugIssue,
  type BugTicket,
  type CustomerFieldMap,
} from "./bugmodel.ts";
import { parseControls, selectSample, type Control } from "./bugselection.ts";
import { rankCandidates, type DuplicateCandidate } from "./bugduplicates.ts";
import { loadAssessments, type Assessment } from "./bugassessment.ts";
import { evaluate, type Packet } from "./bugpolicy.ts";
import {
  bugSummaryText,
  writeBugReport,
  type BugReportInputs,
  type BugReportSummary,
} from "./bugreport.ts";
import { log } from "./log.ts";
import { describeException } from "./redact.ts";
import { IssueValidationError, isRecord } from "./normalize.ts";

export interface BugRunDeps {
  jiraClient?: JiraClient;
}

export interface BugRunResult {
  packets: Packet[];
  summary: BugReportSummary;
  inputs: BugReportInputs;
  text: string;
}

function bugFields(config: Config): CustomerFieldMap {
  return { customerFieldIds: config.bugCustomerFieldIds };
}

async function fetchCorpus(
  client: JiraClient,
  config: Config,
  mapping: CustomerFieldMap,
): Promise<BugTicket[]> {
  const tickets: BugTicket[] = [];
  const seen = new Set<string>();
  let token: string | undefined;
  const limit = config.bugMaxCorpus;
  while (tickets.length < limit) {
    const page = await client.searchJql(
      config.bugsJql,
      Math.min(5000, limit - tickets.length),
      bugSearchFields(config.teamField),
      token,
    );
    if (!isRecord(page) || !Array.isArray(page.issues) || typeof page.isLast !== "boolean") {
      throw new IssueValidationError("unreadable search response");
    }
    for (const issue of page.issues.slice(0, limit - tickets.length)) {
      tickets.push(normalizeBugIssue(issue, config.teamField, mapping));
    }
    if (page.isLast) {
      break;
    }
    const next = page.nextPageToken;
    if (typeof next !== "string" || !next || seen.has(next)) {
      throw new IssueValidationError("search omitted or repeated nextPageToken");
    }
    seen.add(next);
    token = next;
  }
  return tickets;
}

function controlsOf(config: Config): Control[] {
  return parseControls(config.bugControls);
}

function asOfDate(config: Config): Date {
  const parsed = new Date(config.bugAsOf);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export async function runBugTriage(config: Config, deps: BugRunDeps = {}): Promise<BugRunResult> {
  let client = deps.jiraClient;
  if (client === undefined) {
    const { JiraCloudClient } = await import("./jira.ts");
    client = new JiraCloudClient(config);
  }
  const mapping = bugFields(config);
  const asOf = asOfDate(config);

  const corpus = await fetchCorpus(client, config, mapping);
  log.info(`fetched ${corpus.length} corpus ticket(s) for bug triage`);

  const selection = selectSample(
    corpus,
    {
      size: config.bugSampleSize,
      agedDays: config.bugAgedDays,
      seed: config.bugSeed,
      controls: controlsOf(config),
    },
    asOf,
  );
  log.info(`selected ${selection.selected.length} ticket(s) from ${selection.eligible} eligible`);

  const assessments = loadAssessments(config.bugAssessmentsDir);
  const ticketsByKey = new Map(corpus.map((ticket) => [ticket.key, ticket]));

  const packets: Packet[] = [];
  for (const entry of selection.selected) {
    const { ticket } = entry;
    let candidates: DuplicateCandidate[] = [];
    try {
      candidates = rankCandidates(ticket, corpus);
    } catch (error) {
      // Retrieval failure weakens evidence; it never authorizes a close.
      log.warn(`duplicate ranking failed for ${ticket.key}: ${describeException(error)}`);
    }
    const assessment: Assessment | undefined = assessments.get(ticket.key);
    if (assessment === undefined && assessments.size > 0) {
      log.info(`no assessment for ${ticket.key}: recording as unclear`);
    }
    packets.push(evaluate(ticket, candidates, assessment, config.bugCurrentRelease));
  }

  const missing = [...assessments.keys()].filter((key) => !ticketsByKey.has(key));
  for (const key of missing.sort()) {
    log.warn(`assessment for ${key} has no matching ticket in the corpus`);
  }

  const inputs: BugReportInputs = {
    outputDir: config.bugOutputDir,
    asOf: config.bugAsOf,
    currentRelease: config.bugCurrentRelease,
    corpusSize: corpus.length,
    sample: selection.selected,
    selectedCount: selection.selected.length,
    controlCount: selection.selected.filter((entry) => entry.kind === "control").length,
    excluded: selection.excluded,
  };
  const summary = writeBugReport(packets, inputs);
  return { packets, summary, inputs, text: bugSummaryText(inputs, summary) };
}
