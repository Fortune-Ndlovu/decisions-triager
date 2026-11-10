import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { bugSearchFields, normalizeBugIssue, type BugTicket } from "../src/bugmodel.ts";
import { exclusionReason, selectSample } from "../src/bugselection.ts";
import {
  DUPLICATE_CLOSE_THRESHOLD,
  linkRelationship,
  rankCandidates,
  scoreCandidate,
} from "../src/bugduplicates.ts";
import {
  evaluate,
  verifyPacket,
  type Action,
  type Disposition,
  type Packet,
} from "../src/bugpolicy.ts";
import type { Assessment, Evidence } from "../src/bugassessment.ts";
import { runBugTriage } from "../src/bugrun.ts";
import type { JiraClient } from "../src/jira.ts";

const TEAM_FIELD = "customfield_10001";
const AS_OF = new Date("2026-11-09T00:00:00Z");

function issue(key: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key,
    fields: {
      summary: `summary for ${key}`,
      description: null,
      status: { name: "New", category: { name: "To Do" } },
      resolution: null,
      created: "2025-01-01T00:00:00.000+0000",
      updated: "2025-01-02T00:00:00.000+0000",
      priority: { name: "Major" },
      issuetype: { name: "Bug" },
      components: [{ name: "Catalog" }],
      labels: [],
      fixVersions: [],
      versions: [],
      assignee: null,
      reporter: { displayName: "Rita Reporter" },
      issuelinks: [],
      comment: { comments: [] },
      project: { key: "RHDHBUGS" },
      [TEAM_FIELD]: { name: "Platform" },
      ...fields,
    },
  };
}

function bug(key: string, fields: Record<string, unknown> = {}): BugTicket {
  return normalizeBugIssue(issue(key, fields), TEAM_FIELD);
}

function direct(type: Evidence["type"], ref: string): Evidence {
  return { type, ref, why: `evidence at ${ref}`, strength: "direct" };
}

function assessment(overrides: Partial<Assessment> = {}): Assessment {
  return {
    key: "RHDHBUGS-1",
    disposition: "still_valid",
    duplicateOf: "",
    evidence: [direct("repro", "https://example.test/repro")],
    fixPr: "",
    fixCommit: "",
    fixRelease: "",
    fixReleased: false,
    reproResult: "",
    reproRelease: "",
    notes: "",
    comment: "",
    independentPasses: 2,
    agreement: true,
    invalidEvidence: [],
    ...overrides,
  };
}

function candidate(key: string, score: number) {
  return {
    key,
    summary: `summary for ${key}`,
    status: "New",
    score,
    components: ["Catalog"],
    signals: {
      summaryJaccard: 0,
      summaryContainment: 0,
      descriptionJaccard: 0,
      signatureJaccard: 0,
      componentJaccard: 0,
    },
    reasons: ["lexical similarity only"],
  };
}

function actionOf(packet: Packet): Action {
  return packet.action;
}

function dispositionOf(packet: Packet): Disposition {
  return packet.disposition;
}

describe("bug ticket normalization", () => {
  it("reads age, status, links, and versions", () => {
    const ticket = bug("RHDHBUGS-1", {
      issuelinks: [
        {
          type: { name: "Duplicate" },
          outwardIssue: {
            key: "RHDHBUGS-2",
            fields: { summary: "other", status: { name: "New" } },
          },
        },
      ],
      fixVersions: [{ name: "2.1.0" }],
      versions: [{ name: "1.8.0" }],
    });
    expect(ticket.key).toBe("RHDHBUGS-1");
    expect(ticket.team).toBe("Platform");
    expect(ticket.components).toEqual(["Catalog"]);
    expect(ticket.fixVersions).toEqual(["2.1.0"]);
    expect(ticket.affectsVersions).toEqual(["1.8.0"]);
    expect(ticket.links).toEqual([
      {
        type: "Duplicate",
        key: "RHDHBUGS-2",
        direction: "outward",
        summary: "other",
        status: "New",
      },
    ]);
  });

  it("fails closed on a record with no key", () => {
    expect(() => normalizeBugIssue({ fields: {} }, TEAM_FIELD)).toThrow("issue has no key");
  });
});

describe("customer signals", () => {
  it("detects the label", () => {
    expect(bug("RHDHBUGS-1", { labels: ["RHDH-Customer"] }).customerSignals).toContain(
      "label:RHDH-Customer",
    );
  });

  it("detects a support link by its key prefix", () => {
    const ticket = bug("RHDHBUGS-1", {
      issuelinks: [{ type: { name: "Relates" }, outwardIssue: { key: "RHDHSUPP-12" } }],
    });
    expect(ticket.customerSignals).toContain("link:Relates:RHDHSUPP-12");
  });

  it("detects a support key in the text", () => {
    const ticket = bug("RHDHBUGS-1", { description: "See RHDHSUPP-77 for the case." });
    expect(ticket.customerSignals).toContain("text:RHDHSUPP-77");
  });

  it("detects a configured customer custom field", () => {
    const ticket = normalizeBugIssue(
      issue("RHDHBUGS-1", { customfield_10746: "Acme Corp" }),
      TEAM_FIELD,
      { customerFieldIds: ["customfield_10746"] },
    );
    expect(ticket.customerSignals).toContain("field:customfield_10746");
  });

  it("does not flag an ordinary mention of the word case", () => {
    expect(bug("RHDHBUGS-1", { description: "in case of failure" }).customerSignals).toEqual([]);
  });
});

describe("sample selection", () => {
  const config = { size: 10, agedDays: 90, seed: 18094, controls: [] };

  it("excludes customer-linked, Done, and young tickets", () => {
    const customer = bug("RHDHBUGS-1", { labels: ["RHDH-Customer"] });
    const done = bug("RHDHBUGS-2", { status: { name: "Closed", category: { name: "Done" } } });
    const young = bug("RHDHBUGS-3", { created: "2026-10-01T00:00:00.000+0000" });
    const aged = bug("RHDHBUGS-4");

    expect(exclusionReason(customer, AS_OF, 90)).toContain("customer-linked");
    expect(exclusionReason(done, AS_OF, 90)).toContain("done");
    expect(exclusionReason(young, AS_OF, 90)).toContain("younger than 90d");
    expect(exclusionReason(aged, AS_OF, 90)).toBe("");
  });

  it("never samples a customer ticket, even as a control", () => {
    const customer = bug("RHDHBUGS-1", { labels: ["RHDH-Customer"] });
    const result = selectSample(
      [customer],
      { ...config, controls: [{ key: "RHDHBUGS-1", label: "known" }] },
      AS_OF,
    );
    expect(result.selected).toEqual([]);
    expect(result.excluded).toEqual([
      { key: "RHDHBUGS-1", reason: "control is customer-linked (label:RHDH-Customer)" },
    ]);
  });

  it("includes a Done control without proposing anything", () => {
    const done = bug("RHDHBUGS-2", { status: { name: "Closed", category: { name: "Done" } } });
    const result = selectSample(
      [done],
      { ...config, controls: [{ key: "RHDHBUGS-2", label: "known-fixed" }] },
      AS_OF,
    );
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]?.kind).toBe("control");
    expect(result.selected[0]?.controlLabel).toBe("known-fixed");
  });

  it("is deterministic and spreads across strata", () => {
    const tickets = [
      bug("RHDHBUGS-1", { [TEAM_FIELD]: { name: "Alpha" } }),
      bug("RHDHBUGS-2", { [TEAM_FIELD]: { name: "Alpha" } }),
      bug("RHDHBUGS-3", { [TEAM_FIELD]: { name: "Beta" } }),
    ];
    const first = selectSample(tickets, { ...config, size: 2 }, AS_OF);
    const second = selectSample([...tickets].reverse(), { ...config, size: 2 }, AS_OF);
    expect(first.selected.map((entry) => entry.ticket.key)).toEqual(
      second.selected.map((entry) => entry.ticket.key),
    );
    expect(new Set(first.selected.map((entry) => entry.stratum))).toEqual(
      new Set(["Alpha", "Beta"]),
    );
  });

  it("reports a missing control instead of inventing it", () => {
    const result = selectSample(
      [bug("RHDHBUGS-1")],
      { ...config, controls: [{ key: "RHDHBUGS-9999", label: "" }] },
      AS_OF,
    );
    expect(result.excluded).toContainEqual({
      key: "RHDHBUGS-9999",
      reason: "control not present in the corpus",
    });
  });
});

describe("duplicate scoring", () => {
  it("scores a near-identical summary highly", () => {
    const query = bug("RHDHBUGS-1", { summary: "Catalog plugin fails to load with timeout" });
    const same = bug("RHDHBUGS-2", { summary: "Catalog plugin fails to load with timeout" });
    expect(scoreCandidate(query, same).score).toBeGreaterThan(0.9);
  });

  it("caps a reversed Duplicate link below the close floor", () => {
    const query = bug("RHDHBUGS-1", {
      summary: "Catalog plugin fails to load with timeout",
      issuelinks: [{ type: { name: "Duplicate" }, inwardIssue: { key: "RHDHBUGS-2" } }],
    });
    const candidateTicket = bug("RHDHBUGS-2", {
      summary: "Catalog plugin fails to load with timeout",
    });
    const scored = scoreCandidate(query, candidateTicket);
    expect(linkRelationship(query, candidateTicket)).toBe("reverse-duplicate");
    expect(scored.score).toBeLessThan(DUPLICATE_CLOSE_THRESHOLD);
    expect(scored.reasons).toContain("candidate duplicates this ticket");
  });

  it("boosts an outward Duplicate link", () => {
    const query = bug("RHDHBUGS-1", {
      issuelinks: [{ type: { name: "Duplicate" }, outwardIssue: { key: "RHDHBUGS-2" } }],
    });
    const candidateTicket = bug("RHDHBUGS-2");
    expect(linkRelationship(query, candidateTicket)).toBe("duplicate");
    expect(scoreCandidate(query, candidateTicket).reasons).toContain("outward Duplicate link");
  });

  it("ranks by score and excludes the query itself", () => {
    const query = bug("RHDHBUGS-1", { summary: "Catalog plugin fails to load with timeout" });
    const corpus = [
      query,
      bug("RHDHBUGS-2", { summary: "Catalog plugin fails to load with timeout" }),
      bug("RHDHBUGS-3", { summary: "Unrelated helm chart rendering problem" }),
    ];
    const ranked = rankCandidates(query, corpus);
    expect(ranked[0]?.key).toBe("RHDHBUGS-2");
    expect(ranked.map((item) => item.key)).not.toContain("RHDHBUGS-1");
  });
});

describe("disposition policy", () => {
  const ticket = bug("RHDHBUGS-1");

  it("records an unadjudicated ticket as needs_repro", () => {
    const packet = evaluate(ticket, [], undefined, "2.1.0");
    expect(dispositionOf(packet)).toBe("unclear");
    expect(actionOf(packet)).toBe("needs_repro");
    expect(packet.confidenceBasis).toContain("no adjudication supplied");
  });

  it("keeps a still-valid ticket open", () => {
    const packet = evaluate(ticket, [], assessment(), "2.1.0");
    expect(actionOf(packet)).toBe("keep_open");
  });

  it("downgrades a duplicate below the 0.85 floor to comment_only", () => {
    const packet = evaluate(
      ticket,
      [candidate("RHDHBUGS-2", 0.71)],
      assessment({ disposition: "duplicate", duplicateOf: "RHDHBUGS-2" }),
      "2.1.0",
    );
    expect(actionOf(packet)).toBe("comment_only");
    expect(packet.gaps.join(" ")).toContain("below the 0.85 close floor");
  });

  it("closes a duplicate on an outward link with a direct citation", () => {
    const linked = bug("RHDHBUGS-1", {
      issuelinks: [{ type: { name: "Duplicate" }, outwardIssue: { key: "RHDHBUGS-2" } }],
    });
    const packet = evaluate(
      linked,
      [candidate("RHDHBUGS-2", 0.5)],
      assessment({
        disposition: "duplicate",
        duplicateOf: "RHDHBUGS-2",
        evidence: [direct("jira", "RHDHBUGS-2")],
      }),
      "2.1.0",
    );
    expect(packet.explicitDuplicateLink).toBeTruthy();
    expect(actionOf(packet)).toBe("propose_close_duplicate");
  });

  it("closes an already-fixed ticket only with a released fix", () => {
    const fixed = assessment({
      disposition: "already_fixed",
      fixPr: "https://github.com/acme/repo/pull/1",
      fixRelease: "v0.11.0",
      fixReleased: true,
      evidence: [direct("pr", "https://github.com/acme/repo/pull/1")],
    });
    expect(actionOf(evaluate(ticket, [], fixed, "2.1.0"))).toBe("propose_close_fixed");

    const unreleased = { ...fixed, fixReleased: false };
    expect(actionOf(evaluate(ticket, [], unreleased, "2.1.0"))).toBe("comment_only");
  });

  it("closes an obsolete ticket only on direct code/doc/repro evidence", () => {
    const obsolete = assessment({
      disposition: "no_longer_valid",
      evidence: [direct("code", "https://example.test/file#L1")],
    });
    expect(actionOf(evaluate(ticket, [], obsolete, "2.1.0"))).toBe("propose_close_obsolete");

    const weak = assessment({
      disposition: "no_longer_valid",
      evidence: [
        {
          type: "comment",
          ref: "RHDHBUGS-1?focusedCommentId=1",
          why: "owner says so",
          strength: "direct",
        },
      ],
    });
    const packet = evaluate(ticket, [], weak, "2.1.0");
    expect(actionOf(packet)).toBe("comment_only");
    expect(packet.gaps.join(" ")).toContain("no direct code, doc, repro, or release-note evidence");
  });

  it("refuses every close on a customer-linked ticket", () => {
    const customer = bug("RHDHBUGS-1", { labels: ["RHDH-Customer"] });
    const packet = evaluate(
      customer,
      [],
      assessment({
        disposition: "already_fixed",
        fixPr: "https://github.com/acme/repo/pull/1",
        fixRelease: "v0.11.0",
        fixReleased: true,
        evidence: [direct("pr", "https://github.com/acme/repo/pull/1")],
      }),
      "2.1.0",
    );
    expect(actionOf(packet)).not.toBe("propose_close_fixed");
    expect(packet.gaps).toContain("customer-linked; close is disabled");
  });

  it("suppresses a close on an already-Done ticket", () => {
    const done = bug("RHDHBUGS-1", { status: { name: "Closed", category: { name: "Done" } } });
    const packet = evaluate(
      done,
      [],
      assessment({
        disposition: "already_fixed",
        fixPr: "https://github.com/acme/repo/pull/1",
        fixRelease: "v0.11.0",
        fixReleased: true,
        evidence: [direct("pr", "https://github.com/acme/repo/pull/1")],
      }),
      "2.1.0",
    );
    expect(actionOf(packet)).toBe("comment_only");
    expect(packet.gaps).toContain("ticket is already Done; close action suppressed");
  });

  it("downgrades a close when the independent passes disagree", () => {
    const packet = evaluate(
      ticket,
      [candidate("RHDHBUGS-2", 0.9)],
      assessment({
        disposition: "duplicate",
        duplicateOf: "RHDHBUGS-2",
        evidence: [direct("jira", "RHDHBUGS-2")],
        independentPasses: 2,
        agreement: false,
      }),
      "2.1.0",
    );
    expect(actionOf(packet)).toBe("comment_only");
  });

  it("downgrades a close with only one pass", () => {
    const packet = evaluate(
      ticket,
      [candidate("RHDHBUGS-2", 0.9)],
      assessment({
        disposition: "duplicate",
        duplicateOf: "RHDHBUGS-2",
        evidence: [direct("jira", "RHDHBUGS-2")],
        independentPasses: 1,
      }),
      "2.1.0",
    );
    expect(actionOf(packet)).toBe("comment_only");
  });

  it("verifier rejects a close that lost its direct evidence", () => {
    const packet = evaluate(
      ticket,
      [candidate("RHDHBUGS-2", 0.9)],
      assessment({ disposition: "duplicate", duplicateOf: "RHDHBUGS-2" }),
      "2.1.0",
    );
    const broken: Packet = { ...packet, action: "propose_close_fixed", evidence: [] };
    expect(verifyPacket(broken, ticket)).toContain("close proposal has no evidence");
  });
});

describe("bugs mode end to end", () => {
  function fakeClient(issues: Record<string, unknown>[]): JiraClient {
    return {
      searchJql: () => Promise.resolve({ issues, isLast: true }),
      issue: () => Promise.resolve({}),
      updateIssue: () => Promise.resolve(),
      projectComponents: () => Promise.resolve([]),
    };
  }

  it("writes local artifacts, keeps writes empty, and never posts", async () => {
    const root = mkdtempSync(join(tmpdir(), "bugs-"));
    const assessments = join(root, "assessments");
    const output = join(root, "report");
    mkdirSync(assessments, { recursive: true });

    writeFileSync(
      join(assessments, "RHDHBUGS-1.json"),
      JSON.stringify({
        key: "RHDHBUGS-1",
        disposition: "already_fixed",
        fix: { pr: "https://github.com/acme/repo/pull/1", release: "v0.11.0", released: true },
        evidence: [direct("pr", "https://github.com/acme/repo/pull/1")],
        review: { independentPasses: 2, agree: true },
      }),
    );

    const config = loadConfig(
      { JIRA_API_TOKEN: "a@b.test:token" },
      {
        yamlText: [
          "mode: bugs",
          "jira:",
          "  server: https://example.atlassian.net",
          "jql:",
          "  bugs: project = RHDHBUGS",
          "bugs:",
          '  current_release: "2.1.0"',
          "  sample_size: 3",
          '  as_of: "2026-11-09"',
          `  assessments: ${assessments}`,
          `  output_dir: ${output}`,
        ].join("\n"),
      },
    );

    const result = await runBugTriage(config, {
      jiraClient: fakeClient([
        issue("RHDHBUGS-1"),
        issue("RHDHBUGS-2", { labels: ["RHDH-Customer"] }),
        issue("RHDHBUGS-3"),
      ]),
    });

    // The customer ticket is excluded from the sample entirely, so only two
    // packets exist and no packet is customer-linked.
    expect(result.packets).toHaveLength(2);
    expect(result.summary.closeProposals).toBe(1);
    expect(result.summary.customerLinked).toBe(0);
    expect(result.packets.map((entry) => entry.key)).not.toContain("RHDHBUGS-2");

    const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf-8")) as {
      writes: string[];
      dryRun: boolean;
    };
    expect(manifest.writes).toEqual([]);
    expect(manifest.dryRun).toBeTruthy();

    const report = readFileSync(join(output, "report.md"), "utf-8");
    expect(report).toContain("Dry run");
    expect(report).toContain("propose_close_fixed");

    const packet = JSON.parse(readFileSync(join(output, "packets.json"), "utf-8")) as {
      packets: { action: string }[];
    };
    expect(packet.packets.every((entry) => typeof entry.action === "string")).toBeTruthy();

    // No file under proposed/ claims to have posted anything.
    const proposal = readFileSync(join(output, "proposed", "RHDHBUGS-1.md"), "utf-8");
    expect(proposal).toContain("not a close");
    expect(proposal).toContain("Dry run");
  });

  it("requires jql.bugs in bugs mode", () => {
    expect(() =>
      loadConfig(
        { JIRA_API_TOKEN: "a@b.test:token" },
        {
          yamlText: [
            "mode: bugs",
            "jira:",
            "  server: https://example.atlassian.net",
            "jql: {}",
          ].join("\n"),
        },
      ),
    ).toThrow("jql.bugs is required");
  });

  it("does not require a classifier block in bugs mode", () => {
    const config = loadConfig(
      { JIRA_API_TOKEN: "a@b.test:token" },
      {
        yamlText: [
          "mode: bugs",
          "jira:",
          "  server: https://example.atlassian.net",
          "jql:",
          "  bugs: project = RHDHBUGS",
        ].join("\n"),
      },
    );
    expect(config.classifierConfigured).toBeFalsy();
    expect(bugSearchFields(TEAM_FIELD)).toContain("issuelinks");
  });

  it("keeps bugs artifact paths cwd-relative, never package-relative", () => {
    const config = loadConfig(
      { JIRA_API_TOKEN: "a@b.test:token" },
      {
        yamlText: [
          "mode: bugs",
          "jira:",
          "  server: https://example.atlassian.net",
          "jql:",
          "  bugs: project = RHDHBUGS",
        ].join("\n"),
      },
    );
    expect(config.bugOutputDir).toBe("bug-report");
    expect(config.bugAssessmentsDir).toBe("bug-assessments");
  });

  it("still requires a classifier outside bugs mode", () => {
    expect(() =>
      loadConfig(
        { JIRA_API_TOKEN: "a@b.test:token" },
        {
          yamlText: [
            "mode: triage",
            "jira:",
            "  server: https://example.atlassian.net",
            "jql:",
            "  candidate: project = PROJ",
            "  audit: project = PROJ",
          ].join("\n"),
        },
      ),
    ).toThrow("classifier is required");
  });

  it("validates the CLI mode, not the file mode", () => {
    const triageYaml = [
      "mode: triage",
      "jira:",
      "  server: https://example.atlassian.net",
      "jql:",
      "  candidate: project = PROJ",
      "  audit: project = PROJ",
      "classifier:",
      "  backend: llama",
      "  base_url: http://localhost:8080/v1",
      "  model: test-model",
    ].join("\n");

    // The same file is valid as triage but invalid as bugs: --mode bugs
    // must demand jql.bugs instead of silently searching an empty JQL.
    expect(
      loadConfig({ JIRA_API_TOKEN: "a@b.test:token" }, { yamlText: triageYaml, mode: "triage" })
        .mode,
    ).toBe("triage");
    expect(() =>
      loadConfig({ JIRA_API_TOKEN: "a@b.test:token" }, { yamlText: triageYaml, mode: "bugs" }),
    ).toThrow("jql.bugs is required");

    const bugsYaml = [
      "mode: bugs",
      "jira:",
      "  server: https://example.atlassian.net",
      "jql:",
      "  bugs: project = RHDHBUGS",
    ].join("\n");

    // Conversely, a bugs file overridden to triage must demand a classifier,
    // even though the file itself was allowed to omit one.
    expect(
      loadConfig({ JIRA_API_TOKEN: "a@b.test:token" }, { yamlText: bugsYaml, mode: "bugs" })
        .bugsJql,
    ).toBe("project = RHDHBUGS");

    const bugsPlusTriageJql = [
      "mode: bugs",
      "jira:",
      "  server: https://example.atlassian.net",
      "jql:",
      "  bugs: project = RHDHBUGS",
      "  candidate: project = PROJ",
      "  audit: project = PROJ",
    ].join("\n");
    expect(() =>
      loadConfig(
        { JIRA_API_TOKEN: "a@b.test:token" },
        { yamlText: bugsPlusTriageJql, mode: "triage" },
      ),
    ).toThrow("classifier is required");
  });
});
