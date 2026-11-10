// Bugs-mode artifacts. Everything here is local: a report, a packet JSON, a
// CSV, a manifest with an empty writes list, and one proposed comment per
// ticket. Nothing in this module can post or transition anything.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Selection } from "./bugselection.ts";
import type { Packet } from "./bugpolicy.ts";
import { countBy, FIXED_CLOSE_THRESHOLD, OBSOLETE_CLOSE_THRESHOLD } from "./bugpolicy.ts";
import { DUPLICATE_CLOSE_THRESHOLD } from "./bugduplicates.ts";

const DRY_RUN_BANNER =
  "> Dry run. Nothing was posted, transitioned, linked, or written to Jira. " +
  "Proposed comments are local drafts for a human-gated write.";

export interface BugReportInputs {
  outputDir: string;
  asOf: string;
  currentRelease: string;
  corpusSize: number;
  sample: readonly Selection[];
  selectedCount: number;
  controlCount: number;
  excluded: readonly { key: string; reason: string }[];
}

export interface BugReportSummary {
  packets: number;
  withEvidence: number;
  closeProposals: number;
  customerLinked: number;
  evidenceGaps: number;
  dispositions: Record<string, number>;
  actions: Record<string, number>;
}

function csvField(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function renderReport(
  packets: readonly Packet[],
  summary: BugReportSummary,
  inputs: BugReportInputs,
): string {
  const rows = [
    "| Key | Disposition | Confidence | Action | Evidence | Gaps |",
    "|---|---|---|---|---|---|",
    ...packets.map(
      (packet) =>
        `| \`${packet.key}\` | \`${packet.disposition}\` | ${packet.confidence.toFixed(2)} | ` +
        `\`${packet.action}\` | ${packet.evidence.length} | ${packet.gaps.length} |`,
    ),
  ];

  const sections = packets.map((packet) => {
    const lines = [
      `## ${packet.key}`,
      "",
      packet.summary,
      "",
      `- Status: ${packet.status || "unknown"}`,
      `- Disposition: \`${packet.disposition}\` (confidence ${packet.confidence.toFixed(2)})`,
      `- Action: \`${packet.action}\``,
      `- Recommended step: ${packet.recommendedStep}`,
    ];
    if (packet.confidenceBasis.length > 0) {
      lines.push(`- Confidence basis: ${packet.confidenceBasis.join("; ")}`);
    }
    if (packet.target) {
      lines.push(`- Duplicate target: ${packet.target}`);
    }
    if (packet.customerSignals.length > 0) {
      lines.push(`- Customer signals: ${packet.customerSignals.join(", ")}`);
    }
    if (packet.evidence.length > 0) {
      lines.push("", "### Evidence", "");
      for (const item of packet.evidence) {
        lines.push(`- **${item.type}** (${item.strength}) ${item.why} — ${item.ref}`);
      }
    }
    if (packet.duplicateCandidates.length > 0) {
      lines.push("", "### Duplicate candidates", "");
      for (const candidate of packet.duplicateCandidates) {
        lines.push(
          `- \`${candidate.key}\` scored ${candidate.score.toFixed(3)}: ` +
            `${candidate.reasons.join(", ")}`,
        );
      }
    }
    if (packet.gaps.length > 0) {
      lines.push("", "### Gaps", "");
      for (const gap of packet.gaps) {
        lines.push(`- ${gap}`);
      }
    }
    if (packet.verificationErrors.length > 0) {
      lines.push("", "### Verifier", "");
      for (const error of packet.verificationErrors) {
        lines.push(`- ${error}`);
      }
    }
    if (packet.proposedComment) {
      lines.push("", "### Proposed comment (not posted)", "", packet.proposedComment);
    }
    return lines.join("\n");
  });

  return [
    `# Aged-bug triage: ${inputs.currentRelease}`,
    "",
    DRY_RUN_BANNER,
    "",
    `As of ${inputs.asOf}. Corpus ${inputs.corpusSize}, sample ${inputs.selectedCount} ` +
      `(${inputs.controlCount} control).`,
    "",
    "## Summary",
    "",
    `- Packets: ${summary.packets}`,
    `- With cited evidence: ${summary.withEvidence}`,
    `- Local close proposals: ${summary.closeProposals}`,
    `- Customer-linked: ${summary.customerLinked}`,
    `- Evidence gaps: ${summary.evidenceGaps}`,
    `- Dispositions: ${JSON.stringify(summary.dispositions)}`,
    `- Actions: ${JSON.stringify(summary.actions)}`,
    "",
    "## Dispositions",
    "",
    ...rows,
    ...sections,
    "",
  ].join("\n");
}

function renderProposal(packet: Packet): string {
  return [
    `# ${packet.key}: ${packet.action}`,
    "",
    DRY_RUN_BANNER,
    "",
    ...(packet.action.startsWith("propose_close")
      ? [
          "This is a **close proposal**, not a close. A human approves the action and hands " +
            "it to the gated write path; this file changes nothing.",
          "",
        ]
      : ["This is **not a close proposal**. No close is recommended.", ""]),
    `Disposition: \`${packet.disposition}\` (confidence ${packet.confidence.toFixed(2)})`,
    "",
    packet.proposedComment,
    "",
  ].join("\n");
}

export function writeBugReport(
  packets: readonly Packet[],
  inputs: BugReportInputs,
): BugReportSummary {
  const summary: BugReportSummary = {
    packets: packets.length,
    withEvidence: packets.filter((packet) => packet.evidence.length > 0).length,
    closeProposals: packets.filter((packet) => packet.action.startsWith("propose_close")).length,
    customerLinked: packets.filter((packet) => packet.customerSignals.length > 0).length,
    evidenceGaps: packets.reduce((total, packet) => total + packet.gaps.length, 0),
    dispositions: countBy(packets.map((packet) => packet.disposition)),
    actions: countBy(packets.map((packet) => packet.action)),
  };

  mkdirSync(join(inputs.outputDir, "proposed"), { recursive: true });
  writeFileSync(join(inputs.outputDir, "report.md"), renderReport(packets, summary, inputs));
  writeFileSync(
    join(inputs.outputDir, "packets.json"),
    `${JSON.stringify({ schemaVersion: 1, dryRun: true, packets }, null, 2)}\n`,
  );

  const csv = [
    "key,disposition,confidence,action,evidence,gaps,duplicateTarget",
    ...packets.map((packet) =>
      [
        csvField(packet.key),
        csvField(packet.disposition),
        packet.confidence.toFixed(3),
        csvField(packet.action),
        String(packet.evidence.length),
        String(packet.gaps.length),
        csvField(packet.target),
      ].join(","),
    ),
  ].join("\n");
  writeFileSync(join(inputs.outputDir, "summary.csv"), `${csv}\n`);

  for (const packet of packets) {
    writeFileSync(join(inputs.outputDir, "proposed", `${packet.key}.md`), renderProposal(packet));
  }

  const manifest = {
    schemaVersion: 1,
    dryRun: true,
    generatedAt: new Date().toISOString(),
    asOf: inputs.asOf,
    currentRelease: inputs.currentRelease,
    policyVersion: 1,
    corpusSize: inputs.corpusSize,
    sampleSize: inputs.selectedCount,
    controlCount: inputs.controlCount,
    thresholds: {
      duplicate: DUPLICATE_CLOSE_THRESHOLD,
      fixed: FIXED_CLOSE_THRESHOLD,
      obsolete: OBSOLETE_CLOSE_THRESHOLD,
    },
    counts: {
      packets: summary.packets,
      withEvidence: summary.withEvidence,
      closeProposals: summary.closeProposals,
      customerLinked: summary.customerLinked,
      evidenceGaps: summary.evidenceGaps,
    },
    dispositions: summary.dispositions,
    actions: summary.actions,
    excluded: [...inputs.excluded],
    writes: [] as string[],
  };
  writeFileSync(join(inputs.outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return summary;
}

export function bugSummaryText(inputs: BugReportInputs, summary: BugReportSummary): string {
  return [
    `DRY RUN complete: ${summary.packets} packet(s) in ${inputs.outputDir}`,
    `  with cited evidence: ${summary.withEvidence}`,
    `  local close proposals: ${summary.closeProposals}`,
    `  customer-linked: ${summary.customerLinked}`,
    `  dispositions: ${JSON.stringify(summary.dispositions)}`,
    `  actions: ${JSON.stringify(summary.actions)}`,
    "Nothing was posted, transitioned, linked, or written to Jira.",
  ].join("\n");
}
