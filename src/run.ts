// Orchestration: fetch candidates, run the configured mode per ticket,
// record history, summarize, report. One bad ticket must not kill the run.
import type { Config } from "./config.ts";
import { validateConfigFiles } from "./datafiles.ts";
import { buildClassifier, type Classifier } from "./classifier.ts";
import { JiraGateway } from "./gateway.ts";
import type { JiraClient } from "./jira.ts";
import { log } from "./log.ts";
import { auditTicket, evaluate, triageTicket, type ModeContext } from "./modes.ts";
import { describeException, scrub } from "./redact.ts";
import type { TicketResult } from "./records.ts";
import { logTicketResult, summarize, writeReport } from "./report.ts";
import { AuditHistory } from "./state.ts";

export interface RunDeps {
  jiraClient?: JiraClient;
  classifier?: Classifier;
}

export async function run(
  config: Config,
  deps: RunDeps = {},
): Promise<ReturnType<typeof summarize>> {
  if (config.mode === "bugs") {
    // Bugs mode is read-only and model-free; it is orchestrated separately so
    // it cannot accidentally inherit the write path below.
    throw new Error("bugs mode is orchestrated by runBugTriage, not run()");
  }
  if (config.mode === "eval") {
    if (!deps.classifier) {
      throw new Error("eval mode requires a classifier");
    }
    return evaluate(config, deps.classifier);
  }
  const { teams, aliases, descriptions } = validateConfigFiles(config);
  const gateway = new JiraGateway(
    deps.jiraClient ?? (await buildLiveJiraClient(config)),
    teams,
    config.teamNamePrefixes,
    config.teamField,
  );
  const classifier = deps.classifier ?? buildClassifier(classifierConfig(config));
  // Audit state is the audit mode's own resource: only it loads or writes it.
  const history =
    config.mode === "audit"
      ? new AuditHistory(config.stateFile, config.auditRecheckDays)
      : undefined;

  const tickets = await gateway.searchCandidates(
    config.maxTickets,
    config.mode === "audit" ? config.auditJql : config.candidateJql,
  );
  log.info(`fetched ${tickets.length} candidate tickets (max ${config.maxTickets})`);

  const ctx: ModeContext = {
    teams,
    aliases,
    descriptions,
    classifier,
    gateway,
    confidenceThreshold: config.confidenceThreshold,
    dryRun: config.dryRun,
    descriptionMaxChars: config.descriptionMaxChars,
    assigneeRoute: config.assigneeRoute,
    history,
  };

  const results: TicketResult[] = [];
  for (const ticket of tickets) {
    let result: TicketResult;
    try {
      if (config.mode === "audit") {
        const now = new Date();
        result = await auditTicket(ticket, ctx, now);
        history?.record(ticket, result, now);
      } else {
        result = await triageTicket(ticket, ctx);
        for (const decision of result.decisions) {
          decision.old = ticket[decision.field];
        }
      }
    } catch (error) {
      log.error(`triage_ticket failed for ${ticket.key}: ${describeException(error)}`);
      result = {
        key: ticket.key,
        outcome: config.mode === "audit" ? "uncertain" : "error",
        decisions: [],
        writes: [
          {
            key: ticket.key,
            field: "team",
            value: "",
            status: "error",
            reason: describeException(error),
          },
        ],
      };
    }
    logTicketResult(result);
    results.push(result);
  }

  const summary = summarize(results);
  summary.report = writeReport(config, results, summary);
  log.info(`summary: ${JSON.stringify(scrub(summary.counts))}`);
  return summary;
}

async function buildLiveJiraClient(config: Config): Promise<JiraClient> {
  // Deferred import: --check and injected runs never touch the HTTP adapter.
  const { JiraCloudClient } = await import("./jira.ts");
  return new JiraCloudClient(config);
}

/** Narrow the optional backend: only bugs mode may omit the classifier block. */
function classifierConfig(config: Config): Parameters<typeof buildClassifier>[0] {
  if (!config.classifierConfigured) {
    throw new Error("classifier is required outside bugs mode");
  }
  return config;
}
