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
import {
  candidateJql,
  candidateTerms,
  mergeCandidates,
  rankCandidates,
  type DuplicateCandidate,
} from "./bugduplicates.ts";
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

/**
 * One bounded candidate page for a sampled ticket, scoped by the generated
 * JQL. A malformed candidate is skipped, not fatal: retrieval is advisory and
 * cannot authorize a close on its own.
 */
async function fetchCandidates(
  client: JiraClient,
  config: Config,
  mapping: CustomerFieldMap,
  jql: string,
): Promise<BugTicket[]> {
  const limit = config.bugCandidateMaxResults;
  const page = await client.searchJql(jql, limit, bugSearchFields(config.teamField), undefined);
  if (!isRecord(page) || !Array.isArray(page.issues) || typeof page.isLast !== "boolean") {
    throw new IssueValidationError("unreadable candidate search response");
  }
  const tickets: BugTicket[] = [];
  for (const issue of page.issues.slice(0, limit)) {
    try {
      tickets.push(normalizeBugIssue(issue, config.teamField, mapping));
    } catch (error) {
      log.warn(`skipping unreadable duplicate candidate: ${describeException(error)}`);
    }
  }
  return tickets;
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

    // The corpus is the sample pool (aged, open). A closed canonical ticket
    // is often the real duplicate target, so search per ticket with a bounded
    // query that is not limited by the corpus cap.
    if (config.bugCandidateSearch) {
      const terms = candidateTerms(ticket);
      if (terms.length === 0) {
        log.info(`no searchable terms for ${ticket.key}; using corpus candidates only`);
      } else {
        try {
          const found = await fetchCandidates(client, config, mapping, candidateJql(ticket, terms));
          candidates = mergeCandidates([candidates, rankCandidates(ticket, found)]);
          log.info(`candidate search for ${ticket.key}: ${found.length} hit(s)`);
        } catch (error) {
          log.warn(`candidate search failed for ${ticket.key}: ${describeException(error)}`);
        }
      }
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
