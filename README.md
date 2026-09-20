# jevgrep

Semantic code search for coding agents and humans. Command: `jg`.

Built by [Remotehost](https://remotehost.ai). Repository: [remotehostai/jg](https://github.com/remotehostai/jg).

Describe the behavior you need; get source excerpts with exact file/line locations,
match probabilities, and a report of how much code was searched. Jev evaluates
relevance through Vercel AI Gateway. `jg exact` delegates literal/regex search to
ripgrep without changing its arguments or semantics.

**Preview status:** hosted semantic search is not deployed yet. You can use
`jg --dry-run` and `jg exact` locally without a login. `jg login` alone does not
enable hosted search. The public website at **jevgrep.com** is a preview page.
Authentication currently targets the jevgate account backend.

This preview does not establish exhaustive semantic search or measured coding-agent
task speedup.

## Install

Install the public preview:

```sh
npm install -g @remotehost/jg@preview
jg --help
```

Installation and personal or internal business use are permitted by the proprietary
license. Hosted inference requires separate preview access.

## Requirements and preview access

Requires Node.js 22+ and ripgrep. Python syntax parsing additionally uses Python 3.
This package contains only the CLI/MCP client. The website and hosted backend are
separate projects. Hosted semantic search requires preview access; dry-run and
exact modes work without a login. Package: `@remotehost/jg` (public npm package).

Selected source and bounded context are sent to the configured backend for real
inference. Filesystem paths remain local. Use `--dry-run` to inspect payloads
without network calls.

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
- `--broad` judges every discovered snippet, up to 256. Larger scopes fail before model
  calls; narrow paths. Discovery itself is bounded to 20,000 files/chunks and 32 MiB
  of source; individual files are capped at 1 MiB.
- Requests contain at most 16 snippets and 24,000 text/context characters, with up to
  three requests in flight. Transient network errors and HTTP 502/504 responses
  get one bounded retry; authentication and rate-limit failures do not. Any batch failure fails the whole result instead of
  reporting a partial search as success. Ctrl-C cancels in-flight requests.
- Probabilities are cached for ten minutes by query, exact text/context, endpoint,
  account-token hash and client prompt version. Cache files contain only hashes,
  probabilities and expiration, never source text, queries or tokens. Content edits
  invalidate entries. `--no-cache` bypasses it. Model aliases may change within a TTL.
- Matches are probability-ranked; overlapping windows are deduplicated. Defaults:
  threshold 0.7 and limit 10. Thresholds are not calibrated on a representative corpus.

## Output and exact search

```sh
jg --json "reject expired sessions" src/
jg --files "retry failed requests" src/
jg --broad --full "release resources on cancellation" src/network/
jg --dry-run -g '*.ts' "billing rules" src/
jg exact -n --glob '*.ts' 'refreshToken' src/
```

`--json` returns an object with `matches`, `coverage`, `stats`, and `warnings`.
Each match contains `path`, `line`, `endLine`, `text`, `probability`, and optionally
`symbol`. Coverage includes discovered/selected/evaluated snippets, skipped files,
parser counts and whether all eligible snippets were evaluated. `exhaustive` refers
to scope coverage, never guaranteed model recall. A no-match answer is not proof
that a behavior is absent. Dry runs additionally return the exact candidate text
and context. Diagnostics go to stderr.

Terminal output shows 20-line excerpts by default; `--full` shows the whole snippet.
`--files` returns unique paths. Exit codes: 0 matches/preview, 1 no matches, 2 error,
130 interrupted. `jg exact` preserves ripgrep output and exit status. To search a
query named `login`, `status`, `mcp` or another subcommand, put `--` before it.

## Coding agents

An MCP server is included: `jg mcp /absolute/workspace`. It exposes `search_code`
with query, scoped paths, result limit, probability threshold, broad search,
dry-run and cache-bypass options. It validates
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

Once hosted search is deployed:

```sh
jg login
jg status
```

Login uses jevgate's browser device flow and stores credentials at
`~/.jevgrep/config.json` with mode 0600. `jg logout` removes that local copy.
The current identity token is account-wide, not independently scoped/revocable
per product. New account login retains jevgate's existing trial behavior.

The hosted backend is maintained separately. It enforces preview access and
rate limits server-side and holds the Gateway credentials. This repository does
not include production account storage, billing configuration, or infrastructure.

Configuration:

| Variable | Purpose |
| --- | --- |
| `JEVGREP_ENDPOINT` | Backend origin; default `https://jevgate.dev` |
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
