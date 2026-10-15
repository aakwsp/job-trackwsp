# job-trackwsp

A personal tracker for Summer 2027 internship applications. Single user (Moshi,
CS student at Queen's, systems/C background). **Tauri desktop app** — not a
hosted web app, no auth, no multi-user concerns.

## Pipeline

1. Two scheduled Claude tasks (daily + weekly) search for postings and POST them
   to a Google Apps Script endpoint.
2. That endpoint upserts into a Google Sheet, the "discovery inbox", deduplicated
   by `job_key`.
3. This app syncs the sheet into a local SQLite database, parses job-related
   Gmail with an LLM, and shows everything in a desktop UI.

## Layout

```
apps-script/code.gs    the inbox endpoint (deployed in Google, copy kept here)
scheduler/daily.md     prompt for the daily scheduled task ({URL}/{TOKEN} placeholders)
scheduler/weekly.md    prompt for the weekly deep sweep
frontend/              Vite + React 19 + TS + Tailwind v4
src-tauri/             Rust core
```

## Stack

- **Frontend**: Vite, React 19, TypeScript, Tailwind v4 (CSS-first `@theme`, no
  `tailwind.config.js`), Oxlint. Fonts via `@fontsource`.
- **Core**: Rust, Tauri v2, SQLx + SQLite, `reqwest` + `serde` for HTTP,
  `oauth2` for the Gmail loopback flow.
- The frontend calls Rust through Tauri commands (`invoke`). There is no HTTP
  server and no REST API.
- A command declared as a plain `fn` runs on the **main thread** and freezes
  the window until it returns. Anything that can be slow (network, waiting on
  the browser) must be an `async fn` that runs its blocking work through
  `off_main_thread` (`spawn_blocking`) in `lib.rs`. Quick SQLx-only commands
  are `async fn` already.

## Identity and deduplication (important)

The same posting can be found several times with slightly different data. Three
layers of matching, and they must stay identical between `apps-script/code.gs`
and the Rust core:

- `norm(s)`: lowercase, every run of non-alphanumerics becomes one space, trim.
- `job_key`: `company|req_id` when there's a req id, else `company|title|city`,
  each part normalized.
- Fallbacks, in order: `job_key`, then `company|title|city` ("triple"), then the
  URL with query/fragment/trailing slash stripped.

A posting that gains a req id later must **update the existing row's key**, not
insert a new row.

## Data model

- `jobs` — mirrors the sheet. Owned by the sync. `hidden` lets the user dismiss
  a posting without the sync resurrecting it. `removed_at` (JT-26) is when a
  posting disappeared from the sheet: after a sync, rows the response didn't
  include get `removed_at = now`, and a row that reappears gets it cleared.
  The removal pass only runs when the response has a `postings` array with at
  least 50% as many rows as the current non-removed count; otherwise it's
  skipped with a warning, so a failed or partial fetch never marks anything
  removed. A job with an `applications` row is never marked removed. Removal
  is its own column, not a `posting_status` value, because the sync
  overwrites `posting_status` from the sheet. JOBS excludes removed rows by
  default (the "removed" filter row); PIPELINE's record still opens them.
- `applications` — the user's applications. **Never** written by the sync.
  `job_id` is nullable, since the user can apply to things the scheduler never
  found. `status` is stored and recomputed whenever an event is written.
- `emails` — Gmail messages from the job account, unique on `gmail_id`
  (JT-14, `src-tauri/src/mail/`). Each is stored once with its decoded
  plain-text body (`text/plain` preferred, HTML stripped otherwise), then
  filtered at once: `status` is `pending` (on to the LLM, JT-15), `ignored`,
  or `blocked`, and `filter_reason` says why either way. Order: the block
  list (the user's part-time job, `ams.queensu.ca` and Dayforce's `notify@`;
  nothing overrides it), then the allow list, which wins over the ignore
  list. All three are constants in `mail/filter.rs` for now (editable in
  JT-33). **Ignored and blocked mail keeps only `gmail_id`, `from_addr`,
  `subject`, `received_at` and `filter_reason`**: body, snippet, recipient,
  thread and labels are never stored (or are cleared by `mail::refilter`,
  which re-applies the rules to stored mail on start and before each poll).
  Un-ignoring re-fetches from Gmail (`mail::restore`); blocked mail can't be
  restored. The DB runs with `secure_delete` so cleared text is really gone. Polling: on start, every 10 minutes, and on [ check mail ], one
  at a time; the first poll backfills since 2026-08-01, later ones use
  `history.list` from `settings.mail_history_id` (404 → a search since the
  last successful poll). Gmail disconnected = no polling, no errors.
- `extractions` — what the LLM pulled from an email, awaiting confirmation.
  Nothing changes an application until the user confirms.
- `application_events` — the per-application timeline; the latest event
  determines `applications.status`.
- `settings` — small non-secret app values. `gmail_address` is the connected
  job account, which is also the keyring user its token is stored under.
  `mail_history_id`, `mail_last_poll_at` and `mail_last_new` belong to the
  mail poller.

Timestamps are ISO-8601 text (`YYYY-MM-DD` for sheet dates, full
`YYYY-MM-DDTHH:MM:SSZ` for anything the app records). SQLite has no date type
and text sorts correctly.

## Sheet quirks

- Apps Script intermittently returns an HTML error page instead of JSON, even
  though the script ran. **Always retry** a non-JSON response up to 3 times with
  a 10s wait. Writes are idempotent, so retrying a POST is safe.
- Every cell comes back as a string, booleans included: `"true"` / `"false"`.
- The endpoint takes `?token=` on GET and `{"token": ...}` in the POST body.
  Both live in the env as `URL` and `TOKEN` (matches `.env.example` and the
  `{URL}`/`{TOKEN}` placeholders in `scheduler/*.md`).

## Design

The UI mirrors the user's portfolio (aakwsp.xyz, repo `aakwsp/aaq-portfolio`) —
"terminal monastic": editorial serif headings over monospace metadata, all
lowercase, hairline dividers, zero border radius anywhere, no shadows.

- Tokens live in `frontend/src/index.css`. Do not invent colors; use the
  variables.
- `--bg #141216`, `--text #d8cab8`, `--text-muted #8a7e8e`, `--rule #211e26`.
- DM Serif Display for headings, Space Mono for everything else.
- Status shows as a 3px left edge on a row: pink = closing soon, blue =
  borderline, green = applied, grey (`--text-dim`) = past due and not
  applied. A rejected application keeps green and gets a grey flag square.
- Section headers read `// toronto, on` in 10px uppercase mono, with a muted
  count on the right.
- The list must stay **dense**: there are 230+ postings, so rows, not cards.
  Cards are only for a short "closing soon" strip.

## Conventions

- Secrets live in `.env` (gitignored). `.env.example` lists the keys with empty
  values. Never commit a token; never paste one into `scheduler/*.md`, which
  keep `{URL}` / `{TOKEN}` placeholders.
- Gmail (JT-13, `src-tauri/src/gmail/`): the OAuth client is the Desktop app
  client JSON at `~/.config/job-trackwsp/client_secret.json` (Tauri's
  `config_dir()` + `job-trackwsp`), read at runtime and never copied into the
  repo. The refresh token lives only in the OS keyring (service
  `job-trackwsp`, user = the connected address); the access token stays in
  memory. Tokens are never logged or written to a file or the DB.
- **A Secret Service keyring is required** (gnome-keyring, or KeePassXC with
  Secret Service enabled). Without one, connecting fails with a clear error;
  there is deliberately no file fallback. Scope is `gmail.readonly` only.
- Branches are named `moshi/jt-<n>`. Work is tracked in Linear (team key
  `JT`).
- Commit messages and PR titles use `moshi/jt-<n>: <lowercase summary>`,
  e.g. `moshi/jt-35: arrow keys in pipeline`.
- The user is learning frontend — explain non-obvious React and CSS choices
  briefly in comments or in the reply, rather than silently doing the clever
  thing.

## Running locally

- `npm run dev` / `npm run build` from the **repo root** (not `frontend/`) —
  the Tauri CLI needs a cwd containing `src-tauri/`, so `npm --prefix frontend
  run tauri dev` doesn't work.
- On this machine (Wayland + WebKitGTK) two env vars are required, already set
  in the root `dev` script:
  - `GDK_BACKEND=x11` — without it, `Error 71 (Protocol error) dispatching to
    Wayland display`.
  - `WEBKIT_DISABLE_DMABUF_RENDERER=1` — without it, the window opens blank
    with `Failed to create GBM`.
