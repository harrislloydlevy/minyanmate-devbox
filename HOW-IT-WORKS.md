# MinyanMate devbox — how it runs

Last updated: 2026-10-26

This document is for two audiences:

- **Operators** who maintain the container, credentials and gateway.
- **The client agent** (Scorpio, the scrum master) that drives the pipeline.

If you are the agent: read §3 (your tools) and §4 (the task lifecycle) first. Everything else is reference.

---

## 1. What this is

A long-lived development container, `minyanmate-dev`, that owns:

- a clone of `harrislloydlevy/minyanmate`
- one **git worktree per story**, on its own `feature/<id>-<slug>` branch
- OpenCode 2.1.2, running as an ACP agent over SSH
- the Node 24 / pnpm 10 toolchain to build and test the app
- graphify, for a local code knowledge graph
- `gh`, authenticated with a fine-grained PAT
- a preview dev server

The scrum master (OpenClaw) never edits code. It creates the workspace, sends the task over ACP, verifies the result through GitHub, and removes the workspace after merge.

```
Taiga story
   │
   ▼
Scorpio ── devbox__task_new ──▶ worktree + branch + spec + deps + graph
   │
   ├── devbox__task_run({ id, task })
   │        │
   │        └── opencode acp ──▶ edits, tests, commit, push, PR
   │
   ├── verify via GitHub MCP (branch head, PR, CI)
   │
   └── devbox__task_done ──▶ remove worktree (branch kept)
```

---

## 2. Container layout

| Host path | Container path | Purpose |
|---|---|---|
| `/srv/docker/devbox-state/config` | `/home/node/.config` | OpenCode config, gh credentials |
| `/srv/docker/devbox-state/data` | `/home/node/.local/share` | OpenCode DB, sessions |
| `/srv/docker/devbox-state/cache` | `/home/node/.cache` | pnpm store, turbo cache |
| `/srv/docker/devbox-state/work` | `/work` | base clone + task worktrees |
| `/srv/docker/devbox-state/ssh/hostkeys` | `/etc/ssh/dev/hostkeys` | sshd host key |
| `/srv/docker/devbox-state/ssh/authorized_keys` | `/etc/ssh/dev/authorized_keys` | ACP public key |
| `/srv/docker/devbox/devbox` | `/opt/devbox` | helper, MCP server, templates |
| `/srv/docker/secrets/opencode-go.key` | `/run/secrets/opencode_go_key` | OpenCode Go key |
| `/srv/docker/secrets/github-dev-pat` | `/run/secrets/github_pat` | GitHub PAT |

Ports:

- `2222` — sshd, ACP transport. **Not published**; reachable only on `docker_default`.
- `4096` — OpenCode HTTP API. **Not published**; basic auth.
- `3100 → 3000` — preview, published to `127.0.0.1` only.

Worktrees:

```
/work/minyanmate            base clone, branch main, preview runs here
/work/tasks/<story-id>      one worktree per story
```

---

## 3. Tools the scrum master can call

All tools are MCP tools from the `devbox` server (prefix `devbox__`). They run inside the container.

The same documents are exposed as MCP resources:
`devbox://docs/readme`, `devbox://docs/how-it-works`,
`devbox://docs/spec-template`, `devbox://docs/agents-feature-specs`.

### `devbox__help`

Returns the operating documentation. Call it before the other tools.

```json
{ "topic": "overview" }
```

`overview` (default) — README + tool map  
`workflow` — full HOW-IT-WORKS.md  
`tools` — tool reference  
`spec` — spec template + AGENTS rules  
`models` — free-model policy  
`all` — everything

### `devbox__task_new`

Creates a worktree, branch, spec and dependencies.

| Argument | Required | Meaning |
|---|---|---|
| `id` | yes | Story id, e.g. `"42"` |
| `slug` | yes | Kebab-case name, e.g. `"guest-view"` |
| `title` | yes | Human title |
| `spec` | yes | Full markdown for `features/<id>-<slug>.md` |
| `base` | no | Default `origin/main` |
| `model` | no | Optional; omit to let OpenCode choose |
| `graph` | no | Default `true`; set `false` to skip graphify |
| `force` | no | Replace an existing spec / ignore dirty state |

Returns:

```json
{
  "ok": true,
  "path": "/work/tasks/42",
  "branch": "feature/42-guest-view",
  "base_ref": "origin/main",
  "base_sha": "…",
  "spec_path": "features/42-guest-view.md",
  "model": "",
  "reused": false,
  "deps_ok": true,
  "graph": true,
  "graph_ok": true
}
```

Use `path` as the ACP session `cwd`.

It also:

- seeds `.env`, `data/dev.db`, `.opencode/`, `AGENTS.md`
- writes `opencode.json` with the chosen model
- commits the spec as `docs(<id>): add feature spec`
- refuses to overwrite an existing spec unless `force: true`
- refuses a dirty existing worktree unless `force: true`

### `devbox__task_run`

Runs an ACP session, then **delivers** the work: commits anything left,
pushes the branch, opens a draft PR if none exists, and verifies the remote
head. Returns the final text plus a `delivery` block.

| Argument | Required | Meaning |
|---|---|---|
| `id` | yes | Story id; worktree must exist |
| `task` | yes | Prompt for OpenCode |
| `model` | no | Exact id from the `models` list in the result |
| `timeout_seconds` | no | Default 840, max 840 |

Returns:

```json
{
  "ok": true,
  "session_id": "ses_…",
  "stop_reason": "end_turn",
  "model": "opencode-go/iceman-contributor-free",
  "models": ["opencode/beam-free", "…"],
  "text": "…",
  "usage": { "inputTokens": 3717, "outputTokens": 9 },
  "delivery": {
    "ok": true,
    "branch": "feature/42-guest-view",
    "committed": true,
    "commit": "…",
    "local_head": "…",
    "remote_head": "…",
    "pushed": true,
    "pr": { "number": 2, "url": "…", "state": "OPEN", "isDraft": true },
    "error": null
  },
  "error": null
}
```

Blocking. ACP may retry a failing free model several times before giving up. Read `models` if you need a different one.

### `devbox__task_deliver`

Commits any pending changes, pushes the branch, opens a draft PR if none exists,
and verifies the remote head. Use it to retry delivery after a failed
`task_run`, or when work was left uncommitted.

```json
{ "id": "42" }
```

Returns the same `delivery` object shown above.

### `devbox__task_status`

```json
{ "id": "42" }
```

Returns branch, head commit, dirty file count, spec path, graph presence.

### `devbox__task_list`

No arguments. Lists every worktree attached to the base clone.

### `devbox__task_done`

```json
{ "id": "42", "remove": false, "archive": false, "force": false }
```

Marks the worktree done and **keeps it** at `/work/tasks/42`. The branch and all
files stay; `task_status` and `task_list` report `done: true`.

- `remove: true` — delete the worktree (explicit cleanup only).
- `archive: true` — move it to `/work/archive/42`.
- `force: true` — proceed even with uncommitted changes.

The branch is the durable artifact on GitHub. The worktree is a local checkout.

---

## 4. The task lifecycle

### Step 1 — compose the spec

The scrum master builds the markdown from the Taiga story. Use `devbox/templates/spec-template.md` as the shape. Non-negotiable:

- `## Acceptance Criteria` must be present and testable.
- The spec names the branch and source story.
- Do not invent acceptance criteria that are not in Taiga.

### Step 2 — create the workspace

```json
devbox__task_new({
  "id": "42",
  "slug": "guest-view",
  "title": "Guest view",
  "spec": "<full markdown>"
})
```

Check the result:

- `ok: true`
- `deps_ok: true` — otherwise the agent cannot build
- `graph_ok: true` — otherwise graph queries will fail

### Step 3 — run the agent

```
devbox__task_run({
  id: "42",
  task: <prompt below>,
  timeout_seconds: 840
})
```

The tool starts `opencode acp` inside the container and passes `/work/tasks/42` as the ACP `session/new` cwd. It returns when the agent finishes, with the final text, stop reason, token usage, the model list and a `delivery` block.

### Step 4 — the prompt

```
You are implementing story 42 on branch feature/42-guest-view.

Spec: features/42-guest-view.md — read it before any other action.
Acceptance criteria are in that file; do not change them.

Definition of done:
  pnpm typecheck && pnpm test && pnpm build

Rules:
- commit the spec together with your first code commit (it is already committed)
- do not touch main, do not force-push
- do not push or open a PR; the runner delivers the branch and PR
- never commit secrets

Report back: branch, commit SHA, files changed, commands run, pass/fail.
```

Keep the prompt short. The spec is in the worktree; do not paste it twice.

### Step 5 — verify

Do not trust the agent's report. Check the `delivery` block from `task_run`:

- `delivery.ok: true`
- `delivery.pushed: true`
- `delivery.local_head == delivery.remote_head`
- `delivery.pr` has a number and URL

Then confirm through the GitHub MCP: PR open, base `main`, CI status.

### Step 6 — close the story

After the PR merges:

```
devbox__task_done({ "id": "42" })
```

This marks the worktree done and **keeps it**. Do not delete worktrees as routine
cleanup; the branch is on GitHub, the worktree is a local reference. Use
`remove: true` only on explicit instruction or disk pressure.

---

## 5. Spec and AGENTS.md conventions

`task_new` appends this section to the worktree's `AGENTS.md`:

```
## Feature specs
- Read features/<id>-<slug>.md before any code change.
- ## Acceptance Criteria is immutable.
- When functionality changes, append
  ### Follow-up (YYYY-MM-DD): <topic> under ## Implementation Notes.
- Tick ## Definition of Done only for things you verified.
- Commit the spec with the code.
```

The repo's existing feature files already follow this shape: `## Goal`, `## Acceptance Criteria`, `## Constraints & Conventions`, `## Definition of Done`, `## Implementation Notes`.

Generated files are excluded through `.git/info/exclude` (shared across worktrees):

```
graphify-out/
.opencode/
AGENTS.md
opencode.json
```

`.env`, `data/dev.db`, `node_modules` are already gitignored.

---

## 6. Git worktrees — why

A worktree is a second working directory attached to the same `.git`. It shares objects, refs, credentials, hooks and the pnpm store; it has its own files, index, branch, `node_modules` and `graphify-out`.

Worktrees are **local checkouts**. GitHub stores the branch and commits, not the
directory. To get old work on another machine, create a worktree from the branch
(`git worktree add <path> <branch>`). `node_modules`, `.env` and `graphify-out`
are never in GitHub.

- `main` stays checked out in `/work/minyanmate` and is never worked in.
- Each story gets `/work/tasks/<id>` on `feature/<id>-<slug>`.
- No branch switching in a working tree, so no `.next` collisions and no graph rebuild on checkout.
- A branch can only be checked out in one worktree at a time.

---

## 7. Graphify

- `task_new` runs `graphify extract . --code-only` in the new worktree. Local AST, no API key.
- Output: `graphify-out/graph.json`, `GRAPH_REPORT.md`, `graph.html`.
- `graphify update .` re-extracts only changed files (AST, free). `AGENTS.md` tells the agent to do this after code changes.
- `graphify query`, `path`, `explain`, `god-nodes` answer from the graph before grepping.
- Git hooks (`graphify hook install`) are shared via `.git/hooks`; install once in the base clone. They fire on commit/checkout/merge. `post-checkout` is a full rebuild — avoid branch switching in one tree.
- Docs/PDFs/images need the semantic path (`graphify extract .` with a backend); code does not.

---

## 8. Models

- **Free models are the default.** `task_run` picks a free model on every run,
  even if the ACP session starts on a paid one. The result includes `free: true`
  and `free_models`.
- `task_new` writes `opencode-go/iceman-contributor-free` into the worktree's
  `opencode.json`. `task_run` reads that and switches the session to it when the
  session default is not free.
- Paid models are used **only** when the caller passes `model` explicitly. They
  return `429 GoUsageLimitError` on the monthly limit.
- Free availability changes. A dead free endpoint may retry several times, then
  fail with `Endpoint is unavailable`.
- ACP does **not** honour `model` from the worktree's `opencode.json` by itself;
  `task_run` performs the switch. If a requested model is rejected
  (`model not found`), omit it and let the runner pick a free fallback.
- The `models` list is the full catalog; `free_models` is the safe subset.
- Free ids seen in practice: `opencode-go/iceman-contributor-free`,
  `opencode/glm-5.3-flash-free`, `opencode/deepseek-v4.1-flash-free`,
  `opencode/beam-free`, `opencode/mimo-v2.6-flash-free`.

---

## 9. Credentials

| Secret | Path | Used by |
|---|---|---|
| OpenCode Go key | `/srv/docker/secrets/opencode-go.key` | entrypoint POSTs it to `/api/integration/opencode-go/connect/key` |
| GitHub PAT | `/srv/docker/secrets/github-dev-pat` | `gh auth login --with-token` + `gh auth setup-git` |
| OpenCode API password | `/srv/docker/.env` → `MINYANMATE_DEV_OPENCODE_PASSWORD` | HTTP API basic auth |
| ACP SSH key | `/srv/docker/ocsecrets/dev_acp` (gateway) / `/srv/docker/devbox-state/ssh/authorized_keys` (container) | sshd |

Auth persists in `/srv/docker/devbox-state/config/gh/hosts.yml`. An empty GitHub secret file does **not** break existing auth; it only prevents re-auth after the config volume is wiped or the PAT is rotated.

GitHub URL: use **HTTPS**. There is no GitHub SSH key in the container by design. `git@github.com:` will fail with `Permission denied (publickey)`.

---

## 10. Preview

- Runs in `/work/minyanmate` (main), `pnpm dev`, published as `127.0.0.1:3100`.
- Do not run it in a task worktree: `.next` collides with the agent's builds.
- The DB is `data/dev.db`; if the worker logs `no such table: jobs`, run `pnpm db:migrate` in the base clone.
- `.env` is seeded from `.env.example`; auth/webhooks need real values.

---

## 11. Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `Permission denied (publickey)` on git | SSH remote | use `https://github.com/...` |
| `could not read Username` | no gh auth | check PAT file, restart container |
| `429 GoUsageLimitError` | paid model quota | use a free model |
| `provider.no-route` | model not available | pick another from `configOptions` |
| `no worktree at /work/tasks/<id>` | `task_done` already ran | create it again |
| `worktree has uncommitted changes` | agent did not commit | commit or `force: true` |
| Agent starts in the wrong directory | worktree path not used | `task_run` always uses `/work/tasks/<id>` |
| Preview returns nothing | `pnpm dev` crashed | read `/var/log/preview.log` |
| Graph queries return nothing | no `graphify-out` | `task_new` with `graph: true` |

---

## 12. Operator commands

```bash
# container
docker ps --filter name=minyanmate-dev
docker logs -f minyanmate-dev
docker exec -u node -w /work/minyanmate -it minyanmate-dev bash

# auth
docker exec -u node minyanmate-dev gh auth status
docker exec -u node minyanmate-dev git ls-remote \
  https://github.com/harrislloydlevy/minyanmate.git HEAD

# worktrees
docker exec -u node minyanmate-dev /opt/devbox/bin/dev-task list
docker exec -u node minyanmate-dev /opt/devbox/bin/dev-task status --id 42

# graph
docker exec -u node -w /work/tasks/42 minyanmate-dev graphify query "how does RSVP work"
docker exec -u node -w /work/tasks/42 minyanmate-dev graphify god-nodes

# opencode API
docker exec minyanmate-dev sh -lc \
  'curl -s -u "opencode:$OPENCODE_SERVER_PASSWORD" http://127.0.0.1:4096/api/info'

# ACP handshake (from the gateway)
docker exec openclaw-gateway /home/node/.config/devbox-ssh opencode acp
```

---

## 13. Guardrails

- **Never merge to `main`.** Open PRs only; a human merges.
- **Never force-push.**
- **Never commit secrets.**
- **Never edit acceptance criteria** without the story owner's approval.
- **Never delete a branch from inside the agent session.** `task_done` removes the worktree; branch deletion is an operator action after merge.
- **Never trust "done".** Verify branch head, PR and CI through GitHub.
- The repo is public. Assume anything committed is visible.

---

## 14. Current wiring status

- `minyanmate-dev`: running, healthy.
- `devbox` MCP: registered, probe OK; tools `task_new`, `task_run`, `task_deliver`, `task_done`, `task_list`, `task_status`.
- `task_run`: working end-to-end; delivery is deterministic (commit, push, PR, remote-head check).
- `task_deliver`: retries delivery without re-running the model.
- acpx: installed at `2026.10.1`, enabled, `acp` config set, SSH wrapper in place.
- **OpenClaw 2026.10.1 does not expose ACP as a `sessions_spawn` runtime** (the enum only allows `subagent`), and acpx 2026.10.7 requires a newer OpenClaw. That is why `task_run` drives ACP directly. The transport is still ACP over stdio; only the client owner differs.
- If OpenClaw is later updated, `sessions_spawn(runtime:"acp")` can replace `task_run` without changing the worktree, spec or graph parts.
