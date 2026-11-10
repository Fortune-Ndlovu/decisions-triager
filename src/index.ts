// CLI entry point: .env secrets, strict config.yaml, offline --check,
// then one run.
import { cli } from "cleye";
import { loadConfig, type Config } from "./config.ts";
import { validateConfigFiles } from "./datafiles.ts";
import { validateJiraConfig } from "./jira.ts";
import { log } from "./log.ts";
import { describeException, redact } from "./redact.ts";
import { summaryText } from "./report.ts";
import { run } from "./run.ts";

const argv = cli({
  name: "decisions-triager",
  flags: {
    mode: {
      type: String,
      description: "Run mode: triage | audit | eval | bugs",
    },
    report: {
      type: String,
      description: "Write the run report to this path",
    },
    corpus: {
      type: String,
      description: "Labeled export to replay (eval mode)",
    },
    sample: {
      type: String,
      description: "Replay only the first N corpus records",
    },
    check: {
      type: Boolean,
      description: "Validate configuration offline (no network), then exit",
    },
  },
});

const { mode, sample } = argv.flags;

// .env in cwd, stdlib (Node's parser, like dotenv: no var expansion, no
// overriding vars already set in the environment). A missing file is fine;
// a broken file fails closed later: --check rejects the missing token.
try {
  process.loadEnvFile();
} catch {
  // no .env, or unreadable — environments and flags still apply
}
function parseSample(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!/^[+-]?\d+$/.test(raw)) {
    throw new Error("--sample must be an integer >= 1");
  }
  const value = Number(raw);
  if (value < 1) {
    throw new Error("--sample must be >= 1");
  }
  return value;
}

export async function main(): Promise<number> {
  let config: Config;
  try {
    if (mode !== undefined && !["triage", "audit", "eval", "bugs"].includes(mode)) {
      throw new Error("--mode must be one of: triage, audit, eval, bugs");
    }
    // Hand the CLI mode to loadConfig so mode-conditional validation
    // (jql.bugs vs. classifier) sees the mode that will actually run.
    config = loadConfig(process.env, { mode: mode as Config["mode"] | undefined });
    if (argv.flags.report !== undefined) {
      config.reportFile = argv.flags.report;
    }
    config.corpus = argv.flags.corpus;
    config.sample = parseSample(sample);
    if (config.mode === "eval" && !argv.flags.corpus && !argv.flags.check) {
      throw new Error("--mode eval requires --corpus");
    }
    if (argv.flags.check) {
      if (config.mode !== "eval") {
        validateJiraConfig(config);
      }
      // Bugs mode reads Jira and grades local assessments; it needs neither
      // the Team/component catalogs nor a classifier.
      if (config.mode !== "bugs") {
        validateConfigFiles(config);
      }
      if (config.mode === "audit") {
        // audit state loads only for the mode that owns it
        const { AuditHistory } = await import("./state.ts");
        new AuditHistory(config.stateFile, config.auditRecheckDays);
      }
      console.log("configuration valid (no network)");
      return 0;
    }
  } catch (error) {
    log.error(`invalid configuration: ${describeException(error)}`);
    return 1;
  }
  if (config.dryRun) {
    log.info("DRY_RUN=true: no Jira fields will be written");
  }
  try {
    if (config.mode === "bugs") {
      // Bugs mode has no write path at all; it never consults DRY_RUN.
      const { runBugTriage } = await import("./bugrun.ts");
      const result = await runBugTriage(config);
      console.log(redact(result.text, 100_000));
      return 0;
    }
    const summary = await run(config);
    console.log(redact(summaryText(summary), 100_000));
    return summary.counts.error || summary.writeErrors ? 1 : 0;
  } catch (error) {
    log.error(`triage run failed: ${describeException(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.filename && process.argv[1] === import.meta.filename) {
  const exitCode = await main();
  process.exit(exitCode);
}
