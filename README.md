# jevgrep

Semantic code search for coding agents and humans. Command: `jg`.

Built by [Remotehost](https://remotehost.ai). Repository: [remotehostai/jg](https://github.com/remotehostai/jg).

Describe the behavior you need; get source excerpts with exact file/line locations,
compact excerpts and a report of how much code was searched. Jev evaluates
relevance through Vercel AI Gateway. `jg exact` delegates literal/regex search to
ripgrep without changing its arguments or semantics.

**Preview status:** hosted search, email login and CLI connection management live
at **https://jevgrep.com**. Install the preview and run `jg login`. Dry-run and
exact searches work without an account.

This preview does not establish exhaustive semantic search or measured coding-agent
task speedup.

## Install

Install the public preview:

```sh
npm install -g @remotehost/jg@preview
jg --help
```

Installation and personal or internal business use are permitted by the proprietary
license. Hosted inference requires a Jevgrep account.

## Requirements

Requires Node.js 22+ and ripgrep. Python syntax parsing additionally uses Python 3.
This package contains only the CLI/MCP client. The website and hosted backend are
separate projects. Hosted semantic search requires a Jevgrep login; dry-run and
exact modes work without a login. Package: `@remotehost/jg` (public npm package).

Selected source and bounded context are sent to the configured backend for real
inference. Filesystem paths remain local. Use `--dry-run` to inspect the search plan without network calls; add
`--dump-candidates --json` to inspect bounded candidate source.

## Search the whole repository

From the repository root:

```sh
# Inspect everything that would be evaluated; no model calls or login required.
jg --all --dry-run "where do we reject expired sessions?" .

# Sign in with jg login, then search:
jg --all "where do we reject expired sessions?" .
jg --all --json --limit 30 "retry a failed network operation" .
```

`--all` evaluates every eligible snippet in the supplied paths, without a lexical
shortlist. With no path it searches the current directory, including when invoked
by an agent with non-interactive stdin. Run from the repo root or supply that root
explicitly. To search stdin in this mode, supply `-` explicitly.

The default budget is 20,000 snippet evaluations. Use `--max-evaluations N` to set
a smaller budget; exceeding it fails before any model requests rather than silently
omitting code. Discovery still enforces the file, byte and chunk limits below.
Ignored files, hidden files, binary files and other reported skips are not evaluated.
`--all` describes search coverage, not guaranteed semantic recall or one shared
context window containing the entire repo. Jev evaluates separate snippet batches.

Scans use up to three concurrent requests, with no artificial per-minute quota or
fixed delay between batches. Gateway rate-limit responses fail the scan explicitly
rather than returning partial results. Ctrl-C cancels work; cached evaluations can
be reused on a subsequent run. Latency depends on scope and Gateway response time.
Dry-run plans include the estimated request count. `minimumRequestSpanMs` remains
zero for schema compatibility; it is not an estimate of actual completion time.

All-mode returns the top five matches by default. Use `--limit` (up to 100) to
return more; `omittedMatches` reports matches excluded by result or output limits.

## Search behavior

- Discovery uses `rg --files`, preserving ignore rules and omitting hidden files.
  `-g` accepts repeatable ripgrep globs. Explicit files bypass directory ignore rules.
- Every search reads current working files, including uncommitted changes. Duplicate
  real paths are removed. Binary, non-UTF-8, oversized files and giant/minified lines
  are reported as skipped; read errors fail the search.
- JavaScript/TypeScript use TypeScript's syntax tree; Python uses the standard AST.
  Typical functions/methods stay whole. Large declarations and unsupported or
  malformed languages use overlapping windows. `--chunk-lines N` selects fixed
  windows; stdin defaults to individual lines.
- Syntax chunks include up to 2,000 characters of file header/import/constant context
  to resolve references. That context is not itself the target being matched.
- Local BM25 ranks identifiers, symbols, paths and text, with deterministic vocabulary
  expansion. Up to 48 candidate snippets go to Jev by default (`--candidates`, max 256).
  This lexical shortlist can miss semantically relevant code with unrelated wording.
- `--all` judges every eligible snippet, with a default budget of 20,000.
  `--broad` retains its smaller default budget of 256. `--max-evaluations` can set
  either budget up to 20,000. Larger scopes fail before model calls; narrow paths
  or raise the budget. Discovery itself is bounded to 20,000 files/chunks and 32 MiB
  of source; individual files are capped at 1 MiB.
- Requests contain at most 16 snippets and 24,000 text/context characters, with up to
  three API requests in flight. The backend evaluates each snippet in a separate Jev
  state (up to four concurrent model calls per batch), so neighboring snippets do
  not supply evidence for one another. Dry-run request counts are API batches;
  an uncached scan makes one model call per snippet. Transient network errors and HTTP 502/504 responses
  get one bounded retry; authentication and rate-limit failures do not. Any batch failure fails the whole result instead of
  reporting a partial search as success. Ctrl-C cancels in-flight requests.
- Probabilities are cached for ten minutes by query, exact text/context, endpoint,
  account-token hash and client prompt version. Cache files contain only hashes,
  probabilities and expiration, never source text, queries or tokens. Content edits
  invalidate entries. `--no-cache` bypasses it. Model aliases may change within a TTL.
- Matches are ranked by score; overlapping windows are deduplicated. Defaults:
  threshold 0.5 and limit 5. A score is the product of two independent judgments,
  that the snippet acts on the requested entity and that it performs the requested
  operation. It orders results; it is not a calibrated probability, and the default
  threshold is chosen from a small labelled corpus, not a representative one.
- JS/TS and Python declarations longer than 24 lines are split into the blocks
  inside them, so a router or a long loop is judged and quoted one behaviour at a
  time. The split covers every line of the declaration, so coverage is unchanged.
- In a terminal, source lines longer than the window are clipped to one row and
  marked with `…`, keeping line numbers aligned. Redirected and `--json` output is
  never clipped, so byte budgets do not depend on the terminal.

## Output and exact search

```sh
jg --json "reject expired sessions" src/
jg --files "retry failed requests" src/
jg --broad --full "release resources on cancellation" src/network/
jg --dry-run -g '*.ts' "billing rules" src/
jg exact -n --glob '*.ts' 'refreshToken' src/
```

Plain queries search the current directory recursively, even when an agent runs
with non-interactive stdin. Supply paths to scope the search. Reading stdin always
requires an explicit `-` (for example, `cat file.log | jg "expired" -`).

Default output contains up to five matches, each with its path, exact excerpt
line range, optional symbol and source text. Excerpts contain at most 12 lines and 1,200 characters. For longer snippets,
the excerpt is taken from the narrower block Jev judged relevant when there is
one, and a local query-based window picks the lines inside it otherwise; both
only locate the excerpt and neither changes Jev’s relevance decision. A match
whose path is a test carries `kind: "test"`. Tests often are the clearest
evidence of a behaviour, so they are ranked on merit and labelled rather than
demoted. One coverage summary follows; scores, request timings
and parser details are hidden unless `--debug` is supplied.

`--json` and MCP share a versioned result schema:

```json
{
  "schemaVersion": 1,
  "matches": [{
    "path": "src/auth.ts",
    "startLine": 42,
    "endLine": 44,
    "symbol": "validateSession",
    "text": "if (session.expiresAt <= Date.now()) {\n  throw new Error(\"expired\");\n}"
  }, {
    "path": "test/auth.test.ts",
    "startLine": 12,
    "endLine": 13,
    "kind": "test",
    "text": "const expired = token({ expiresAt: past });\nassert.equal(await call(expired), 401);"
  }],
  "coverage": {
    "mode": "shortlist",
    "files": 30,
    "evaluated": 48,
    "eligible": 260,
    "selected": 48,
    "skipped": 0,
    "selectionComplete": false,
    "evaluationComplete": false
  },
  "truncated": false,
  "omittedMatches": 0
}
```

Terminal output uses aligned line-number gutters and exact source text. Interactive
progress updates one stderr line; redirected output contains no terminal escapes.
JSON and MCP retain their versioned structured format.

`--max-output` bounds each result representation to 8,000 UTF-8 bytes by default,
including metadata and the CLI trailing newline (range: 1,024–64,000).
MCP returns the same bounded payload as structured content and a compatible JSON
text block. The protocol envelope and stderr progress are outside this budget.
Output is never cut into invalid JSON: excerpts are shortened or lower-ranked
matches omitted. `truncated` signals any shortened excerpt, omitted match,
candidate, or diagnostic detail. `omittedMatches` counts excluded matching
snippets, not excluded files. An excerpt's `endLine` describes its displayed text;
`excerptTruncated` and `sourceEndLine` identify a shortened source range.
`--full` requests full snippets but still respects the total budget. Increase
`--limit` or `--max-output`, or read the source range, for more context.

`selectionComplete` means every discovered eligible snippet was selected.
`evaluationComplete` additionally requires evaluation to finish with no skipped
files; it is always false in dry-run mode. Ignored and hidden files are excluded
from discovery. No coverage flag guarantees model recall, and a no-match response
is not proof that a behavior is absent.

`--dry-run` prints a compact plan with file/snippet counts and request estimates,
without source code or model calls. With `--json`, it adds `dryRun` and `plan`
fields to the same schema. `--dump-candidates` explicitly includes candidate text
and context within the output budget, with `omittedCandidates` reporting the rest.
`--debug` adds match probabilities and bounded `diagnostics`; neither option is
needed for normal agent use.

`--files` prints only unique matching paths, with truncation notices on stderr.
Progress, when attached to a terminal or explicitly debugging, goes to stderr;
JSON stdout stays machine-readable. Exit codes: 0 matches/preview, 1 no matches,
2 error, 130 interrupted. `jg exact` preserves ripgrep output and exit status.
To search a query named `login`, `status`, `mcp` or another subcommand, put `--`
before it. `0.4.0` changes the earlier preview JSON contract; consumers should
use `schemaVersion: 1`, `startLine`, and the coverage fields above. `kind` is
optional and only ever `"test"`; consumers that ignore unknown fields are
unaffected.

## Coding agents

An MCP server is included: `jg mcp /absolute/workspace`. It exposes `search_code`
with query, scoped paths, result limit, probability threshold, broad search, all-snippet search (`all: true`), evaluation budget (`max_evaluations`),
dry-run, cache-bypass, `max_output`, `full`, `debug`, and `dump_candidates` options. It validates
workspace boundaries and returns compact source excerpts plus coverage.
After installing the client and signing in, register it with Codex:

```sh
codex mcp add jevgrep -- jg mcp /absolute/path/to/workspace
```

Restart the agent session after registration. No global agent configuration is
silently modified.

Use semantic search for unknown symbols and behavior-based discovery. Keep ripgrep
for exact symbols, regex and exhaustive references; do not alias `rg` to `jg`.

## Authentication and hosted backend

```sh
jg login
jg status
```

Login opens Jevgrep's browser device approval page. Sign in by email, verify the
code matches your terminal, then approve. Credentials are stored at
`~/.jevgrep/config.json` with mode 0600. Each CLI connection has a separate token
that expires after 90 days. `jg logout` revokes the current token and removes the
local login; you can also revoke connections at https://jevgrep.com/account.

Version 0.6.0 changes result scoring and chunking, so results differ from 0.5.x.
A score is now the product of the two judgments rather than the lower of them,
declarations longer than 24 lines are judged as the blocks inside them, and
matches under a test path carry `kind: "test"`. The default threshold stays 0.5,
which a three-run evaluation on the bundled corpus put between the highest
graded hard negative (0.46) and the lowest correct answer (0.55). Scores are on
a different scale from 0.5.x, so a pinned custom `--threshold` should be
re-checked; cached scores from earlier versions are not reused.

Version 0.5.0 moves authentication and search to Jevgrep's independent backend.
Old Jevgate logins are not migrated; run `jg login` again. Source and query text
are not stored in Jevgrep's database; account, hashed token and usage metadata are.
The server calls Jev through Vercel AI Gateway using server-side credentials.
This distribution does not include the website, database or infrastructure.

Configuration:

| Variable | Purpose |
| --- | --- |
| `JEVGREP_ENDPOINT` | Backend origin; default `https://jevgrep.com` |
| `JEVGREP_TOKEN` | Explicit token for automation |
| `JEVGREP_CONFIG_DIR` | Login storage directory |
| `JEVGREP_CACHE_DIR` | Probability cache; default `~/.cache/jevgrep` |

Saved credentials are bound to the login origin and are not forwarded on endpoint
changes. Only HTTPS origins and local HTTP are accepted; requests reject redirects.
`.env` is not automatically loaded by the CLI; use Node's `--env-file` if needed.

## Distribution repository

This repository is a generated CLI distribution. Development, tests and application
services are maintained separately. Make changes in the internal source repository.
This public repository contains only the client distribution. The CLI is publicly distributed on npm under a proprietary license.

## Contributions and support

This is a generated distribution repository. Development and tests are maintained
internally, and external pull requests are not currently accepted. You can report
CLI bugs or request features through [GitHub issues](https://github.com/remotehostai/jg/issues).
Include the package version, operating system and a minimal reproduction using
non-sensitive sample code. Do not include credentials or private source code.
The proprietary license governs use; public visibility does not make this open source.

## License

**Proprietary. All rights reserved.** This is not open-source software.
You may install and use the unmodified CLI for personal or internal business purposes.
Modification, redistribution, resale and sublicensing require separate written permission.
See [LICENSE](LICENSE). Third-party dependencies retain their own licenses.
Public npm availability does not make this software open source.

Not affiliated with TypeSafe, Vercel or OpenAI.
