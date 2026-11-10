# decisions-triager — guarded Jira auto-triage

Fetches open Jira tickets that are missing **Team** and/or **component**,
decides the missing fields with a decision model, and fills them in —
behind a fail-closed safety model so a bad config, a flaky model, or a
racy edit can never corrupt your tracker.

Classification runs through [`jira.js`](https://github.com/mrrefactoring/jira.js)

- [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi-ai) behind
  a small adapter layer: by default a self-hosted llama.cpp System One
  decision model; `classifier.backend: openai` swaps to OpenAI's Decisions
  API with a config change. TypeScript, no build step — Node runs the source
  directly.

This README is organized by what you're here to do: a tutorial to get a
first dry run working, how-to guides for common tasks, reference for every
knob, and an explanation of the safety model.

## Tutorial: first dry run in 5 minutes

You will clone the repo, point it at a Jira site with fictional-but-valid
catalogs, and run it in dry-run mode — no writes, no model server needed
to validate the setup.

You need **Node 24+** (the tool runs TypeScript directly, no build step)
and **pnpm** (`corepack enable` or `npm i -g pnpm`). Everything else —
Jira site, API token, catalogs, classifier — is configured in the steps
below. A Jira Cloud site with the **Teams** feature and a custom **Team**
field is assumed; the token's account needs read access plus edit on the
projects in your JQL.

1. **Install.**

   ```bash
   git clone https://github.com/schultzp2020/decisions-triager
   cd decisions-triager
   pnpm install
   pnpm check   # lint + format + tests; all offline
   ```

2. **Create your config.** Copy the example files — the copies are
   gitignored, because they name your site and your teams:

   ```bash
   cp config.example.yaml config.yaml
   cp teams.example.json teams.json
   cp components.example.json components.json
   cp .env.example .env
   ```

3. **Fill in `config.yaml`**: set `jira.server` to your Jira site, the
   two `jql.*` queries to your projects, and the `classifier` block to
   your backend, endpoint, and model. If your Team custom field is not
   `customfield_10001`, set `jira.team_field`: Jira → Settings →
   Issues → Custom fields, open your Team field, and read the
   `customfield_...` id from the URL.

4. **Fill in the catalogs.**

   - `teams.json` — one entry per team:
     - `id`: the Atlassian team UUID. Find it in Jira's Teams directory
       (the team page URL contains it). If you can only find the name,
       put any placeholder UUID in and run a dry run: the tool reads the
       live UUID from search results and warns with the exact value it
       observed (`team UUID conflict for ...`), in dry run, with nothing
       written.
     - `members`: assignee display names, used by the deterministic
       assignee→team pre-route (case-insensitive).
     - `components`: the team's component scope, shown to the model as
       team criteria.
   - `components.json` — one entry per **canonical component**, exactly
     as the name appears in the live Jira project (the tool fetches the
     live list and only writes names that exist there), plus
     `description` (shown to the model) and `aliases` (labels the model
     may answer with, canonicalized before validation).

5. **Add your credential** to `.env`:

   ```dotenv
   JIRA_API_TOKEN=you@example.com:your-api-token
   ```

   Create the token at Jira → Settings → Security → API token
   (`email:token` is sent as Basic auth to your configured origin only).
   For the `openai` classifier backend, also add `CLASSIFIER_API_KEY=`;
   the tool refuses to start without it.

6. **Validate offline.**

   ```bash
   node src/index.ts --check
   ```

   Expected output: `configuration valid (no network)`. Any config typo,
   unknown key, malformed catalog, or bad credential shape aborts here
   with a precise message.

7. **Dry run.**

   ```bash
   node src/index.ts
   ```

   The tool fetches candidates (default limit 100), asks the classifier,
   and logs one structured JSON line per ticket — but since `dry_run`
   defaults to `true`, nothing is written to Jira. A `report-*.json`
   artifact lands in the working directory; open it and check the
   `decisions` and `writes` entries.

To make the run meaningful you need a classifier: a local `llama-server`
on `http://localhost:8080` serving a System One decision model, or the
OpenAI backend (next section). With no classifier reachable, every ticket
is recorded as `classify-failed` and nothing is written — that is the
intended behavior.

## How-to guides

### Swap llama.cpp → OpenAI Decisions

In `config.yaml`:

```yaml
classifier:
  backend: openai
  base_url: https://api.openai.com/v1
  model: gpt-6-luna
```

Add `CLASSIFIER_API_KEY=sk-...` to `.env`. Both backends answer the same
two questions per ticket (Team, component) with choice + confidence +
probability distributions; the policy layer treats them identically, so
nothing else changes. To go back, restore `backend: llama` with your
`llama-server` base URL and model id.

The llama backend reads next-token probabilities from `llama-server`, so
its confidence numbers are actual model probabilities; no API key is
needed on a trusted network.

### Go live

1. Confirm the dry-run report looks sane over a few runs.
2. Set `dry_run: false` in `config.yaml` — or keep the file at `true` and
   flip only the scheduled invocation with `DRY_RUN=false` in the
   environment, which overrides the file. The env value is strict:
   anything but `true`/`false` aborts startup.
3. Schedule it, e.g. cron:

   ```cron
   0 */2 * * * cd /srv/decisions-triager && DRY_RUN=false node src/index.ts >> triager.log 2>&1
   ```

Read the safety model below for exactly what can and cannot be written.

### Audit stale assignments

```bash
node src/index.ts --mode audit
```

Audit re-checks tickets whose Team and component are already set and
corrects validated, high-confidence mismatches. Corrected tickets are
remembered in `triager-state.json` (atomic writes) and deduplicated for
`audit.recheck_days` (default 30) so the same ticket isn't re-litigated
every run. Dry-run rules apply here too: `dry_run: true` computes and
reports corrections but writes nothing and records no state.

### Evaluate a labeled export

```bash
node src/index.ts --mode eval --corpus export.json --sample 100
```

Eval replays a labeled corpus (`key`, `title`, `description`, `team`,
`component` per row — labels may be `null`) through the classifier only;
it never contacts Jira. The report contains per-field agreement rates,
confusion matrices (with `<empty>`, `<invalid>`, `<classify-failed>`
sentinels), the confidence distribution, and would-write counts.
`--sample 100` replays only the first 100 rows.

### Triage aged bugs

```bash
node src/index.ts --mode bugs
```

Bugs mode asks a different question from the other three: not "who owns
this ticket", but "should this aged report stay open". It samples aged,
non-customer bugs, ranks duplicate candidates, grades the assessments you
supply, and writes local artifacts.

Two retrievals feed the duplicate check. The corpus (`jql.bugs`) is the
**aged, open sample pool** and is capped by `bugs.max_corpus`. Per sampled
ticket, a second bounded query searches the same project for matches
regardless of status or age, so a closed canonical ticket that the corpus
cap would hide is still found. That query is `summary ~` on up to four
sanitized summary words, restricted to `created <=` the ticket's own date
and ordered by Jira relevance, limited by `bugs.candidate_max_results`.
Retrieval never decides a duplicate by itself; the policy still requires a
direct citation and the 0.85 floor.

**It has no write path.** It never comments, transitions, links, or edits
a field, and `dry_run` does not apply because there is nothing to turn
off. Every close is a local proposal in `bug-report/proposed/`; approving
one is a separate, gated step.

The mode needs an assessment per ticket in `bugs.assessments`, one
`KEY.json` each:

```json
{
  "key": "RHDHBUGS-1234",
  "disposition": "already_fixed",
  "fix": { "pr": "https://github.com/acme/repo/pull/1", "release": "v0.11.0", "released": true },
  "evidence": [
    {
      "type": "pr",
      "ref": "https://github.com/acme/repo/pull/1",
      "why": "patches the duplicate secret path",
      "strength": "direct"
    }
  ],
  "review": { "independentPasses": 2, "agree": true }
}
```

The assessment supplies claims and citations, never a confidence number.
The policy derives confidence from evidence strength and applies the
close gates:

- **duplicate** — an outward Jira Duplicate link, or a candidate score of
  at least 0.85, plus a direct citation of the target. An inward "is
  duplicated by" link means the _other_ ticket is the duplicate and caps
  the pair below the floor. So does a candidate created after the ticket:
  the older report is the canonical one, and a newer match is a hint only.
- **already_fixed** — a merged PR or commit, a named release that carries
  it, `released: true`, and a fix release no newer than the release under
  review. Whether that release actually contains the commit is a supplied
  claim; independent release verification is a separate step.
- **no_longer_valid** — direct code, documentation, reproduction, or
  release-note evidence.
- **all closes** — at least 0.80 confidence (0.85 for duplicate), two
  agreeing independent passes, and a ticket that is neither
  customer-linked nor already Done.

A failed gate downgrades to `comment_only` or `needs_repro`; it never
becomes a close. A missing assessment is `unclear`, not a guess.

Run `--check` first: bugs mode skips the Team/component catalogs and the
classifier block, so it validates with just `jira.server` and `jql.bugs`.

## Reference

### `config.yaml`

Validated against a [TypeBox](https://github.com/sinclairzx81/typebox)
schema at startup: unknown keys and wrong types abort the run — a typo
can never silently enable live writes. Required settings:

| Setting               | Purpose                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `jira.server`         | Exactly one `https` origin, e.g. `https://your-site.atlassian.net` — no port, path, query, fragment, or user info |
| `jql.candidate`       | Search for tickets missing Team and/or component                                                                  |
| `jql.audit`           | Search for tickets with Team and component both set                                                               |
| `jql.bugs`            | Corpus for `bugs` mode: aged, non-customer bug reports (required only in `bugs` mode)                             |
| `team_name_prefixes`  | Prefixes stripped from live Jira team names before catalog matching (case-insensitive), e.g. `["ACME "]`          |
| `jira.team_field`     | Jira custom field id for Team (default `customfield_10001`)                                                       |
| `classifier.backend`  | `llama` (System One on llama.cpp) or `openai` (Decisions API) — there is no default provider                      |
| `classifier.base_url` | Classifier endpoint, e.g. `http://localhost:8080/v1` or `https://api.openai.com/v1`                               |
| `classifier.model`    | Model id, e.g. `ggml-org/vllm-d3-flash-GGUF:Q8_0` or `gpt-6-luna`                                                 |

Optional settings:

| Setting                            | Default                   | Purpose                                                 |
| ---------------------------------- | ------------------------- | ------------------------------------------------------- |
| `mode`                             | `triage`                  | `triage` \| `audit` \| `eval` \| `bugs`                 |
| `classifier.timeout_seconds`       | `60`                      | Per-request timeout (>= 1)                              |
| `confidence_threshold`             | `0.7`                     | Minimum confidence to write (inclusive), `[0, 1]`       |
| `assignee_route`                   | `true`                    | Deterministic assignee→team pre-route                   |
| `dry_run`                          | `true`                    | `false` enables live Jira writes                        |
| `max_tickets`                      | `100`                     | Candidate limit per run (>= 1)                          |
| `description_max_chars`            | `48000`                   | Cap on the description sent to the classifier (>= 500)  |
| `audit.recheck_days`               | `30`                      | Dedup interval for re-audits (>= 0)                     |
| `audit.state_file`                 | `triager-state.json`      | Audit history (atomic JSON, cwd-relative)               |
| `report_file`                      | `report-<timestamp>.json` | Per-run JSON artifact                                   |
| `files.teams` / `files.components` | shipped files             | Catalog paths (package-relative when bare)              |
| `bugs.current_release`             | `2.1.0`                   | Release a still-valid claim is checked against          |
| `bugs.aged_days`                   | `90`                      | Minimum age in days for the aged sample                 |
| `bugs.sample_size`                 | `12`                      | Aged tickets in the sample                              |
| `bugs.seed`                        | `18094`                   | Stable sample order seed                                |
| `bugs.as_of`                       | today                     | `YYYY-MM-DD` reference date for age arithmetic          |
| `bugs.max_corpus`                  | `1000`                    | Corpus cap for duplicate retrieval                      |
| `bugs.controls`                    | `[]`                      | Known-answer tickets, `KEY` or `KEY=label`              |
| `bugs.assessments`                 | `bug-assessments`         | Directory of `KEY.json` assessments                     |
| `bugs.output_dir`                  | `bug-report`              | Local artifact directory                                |
| `bugs.customer_field_ids`          | `[]`                      | Custom field ids that mark a ticket customer-linked     |
| `bugs.candidate_search`            | `true`                    | Per-ticket search for older/closed duplicate candidates |
| `bugs.candidate_max_results`       | `50`                      | Max candidates fetched per sampled ticket               |

Relative catalog paths (`files.*`) resolve against the package
directory. `bugs.assessments` and `bugs.output_dir` are runtime
artifacts and stay cwd-relative.

### Secrets and environment

| Variable             | Purpose                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `JIRA_API_TOKEN`     | `email:api-token`, Basic auth to the configured origin only             |
| `CLASSIFIER_API_KEY` | Required for the `openai` backend; optional for local llama             |
| `DRY_RUN`            | Strict `true`/`false` override of `dry_run` (the cron switch)           |
| `TRIAGER_CONFIG`     | Path to a different config file (default: `config.yaml` in the package) |

Secrets load from `.env` in the working directory (Node's built-in
`process.loadEnvFile`: no variable expansion, existing environment
variables win). Tokens and the encoded credential are registered for
redaction and never appear in logs, reports, or state files.

### CLI

```
node src/index.ts [--mode triage|audit|eval] [--check] [--report <path>]
                  [--corpus <path>] [--sample <n>]
```

| Flag       | Effect                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------- |
| `--check`  | Validate config, catalogs, credentials (and audit state, in audit mode) offline; no network |
| `--mode`   | Override `mode`                                                                             |
| `--report` | Write the run report to this path                                                           |
| `--corpus` | Labeled export for eval mode (required unless `--check`)                                    |
| `--sample` | Replay only the first N corpus records (integer >= 1)                                       |

Exit code `0` on success; `1` on any run failure, per-ticket error, or
write error. Errors are logged in two phases — `invalid configuration:`
before any run, `triage run failed:` after.

### Run artifacts

- `report-<timestamp>.json` — full per-ticket decisions, write statuses,
  and counts (secrets redacted).
- `reports/index.jsonl` — one line per run with its report path.
- `triager-state.json` — audit history (audit mode only), atomic writes.

## Explanation: the safety model

The triager's contract is that it may only ever fill or correct fields it
was explicitly configured to touch, and only when every check along the
way passed. Every layer fails closed:

- **Dry-run default.** Nothing is written unless the config — or the
  deliberate `DRY_RUN=false` env override — says otherwise.
- **One origin, one credential path.** `jira.server` must be exactly one
  `https` origin, validated before any credential is constructed.
  Mutations never follow redirects (a 301 destroys PUT bodies), requests
  are single-attempt with a 30s timeout, and HTTP failures surface the
  status code only — response bodies never reach logs or reports.
- **Validated inputs.** Fetched issues are validated before anything is
  decided: keys must be readable and match on re-fetch, requested fields
  must be present with supported shapes. Omitted or unreadable shapes
  fail the ticket — they never count as "missing" (writable) fields, and
  no project default is ever assumed. Descriptions accept strings or
  validated Cloud ADF documents (max depth 10, max 10,000 nodes).
- **Deterministic first.** Both fields already set → skip, no model call.
  Assignee is a known team member → assign that team directly, no model
  call. The model is only asked for what's genuinely undetermined.
- **Classifier failure suppresses all writes for the ticket** — including
  the deterministic assignee-routed team. Every undecided field is
  recorded as `classify-failed`; nothing is written.
- **Validated answers.** A choice must be an allowed label, confidence a
  number in `[0, 1]` at or above `confidence_threshold`. Anything else
  abstains — no write, logged for human review. There is no fallback
  model.
- **Live component gating.** Predicted components are canonicalized
  through `components.json` and must exist in the live Jira project
  component list; lookup failure or an unknown canonical name abstains.
  Unvalidated labels are never written.
- **Race defense.** Jira offers no atomic compare-and-set, so before each
  write the issue is re-fetched and the field written only if still
  missing (or unchanged since the search snapshot in audit mode); the
  update path re-fetches and verifies twice more, skipping
  (`skipped-race`) any field that changed. A small residual race window
  remains — that's inherent to the Jira API, which is why every write
  path is also independently guarded.
- **Authoritative team UUIDs.** Team writes use catalog UUIDs with a live
  cross-check: a live Jira UUID that disagrees with the catalog marks the
  team conflicted for the run and Team writes for it abstain
  (`team-uuid-conflict`).
- **Bounded, redacted diagnostics.** Configured tokens and the encoded
  credential never appear in logs, reports, or the audit state file.

## License

Apache-2.0 — see [LICENSE](LICENSE).
