# minyanmate-devbox

The development environment for [MinyanMate](https://github.com/harrislloydlevy/minyanmate):
a long-lived container that runs OpenCode as an ACP agent, one git worktree per
story, and a local code knowledge graph.

This repository contains **code only**. Runtime state and credentials live
outside it, under `/srv/docker/devbox-state` and `/srv/docker/secrets`.

Read **[HOW-IT-WORKS.md](HOW-IT-WORKS.md)** for the full runbook, tool
reference and failure modes.

---

## What is in here

```
image/                  Dockerfile, entrypoint, sshd config
devbox/bin/dev-task     worktree + branch + spec + deps + graph helper
devbox/mcp/             MCP server: task_new, task_run, task_done, task_list, task_status
devbox/templates/       spec template and AGENTS.md feature-spec rules
gateway/devbox-ssh      SSH wrapper used by the gateway and acpx
HOW-IT-WORKS.md         operator and agent runbook
deploy.sh               rebuild and restart the service
```

Not in here, by design:

```
/srv/docker/devbox-state/{config,data,cache,work,ssh}
/srv/docker/secrets/{opencode-go.key,github-dev-pat}
/srv/docker/docker-compose.yml          ← the service definition lives here
```

`.gitignore` blocks all of those paths. This repo can be public because none of
them can be committed.

---

## Prerequisites

- Docker + Compose
- A host directory layout:

  ```
  /srv/docker/devbox              this repo
  /srv/docker/devbox-state        state (created on first run)
  /srv/docker/secrets             credentials
  ```

- `/srv/docker/secrets/opencode-go.key` — OpenCode Go API key
- `/srv/docker/secrets/github-dev-pat` — fine-grained GitHub PAT
  (Contents RW, Pull requests RW, Metadata R, Actions R)
- An ACP SSH key pair:
  - private half at `/srv/docker/ocsecrets/dev_acp`
  - public half at `/srv/docker/devbox-state/ssh/authorized_keys`
- `MINYANMATE_DEV_OPENCODE_PASSWORD` in `/srv/docker/.env`

---

## The compose service

The service is defined in `/srv/docker/docker-compose.yml` as `minyanmate-dev`.
It is **not** split into a second compose file. Build and run from the host:

```bash
cd /srv/docker
docker compose up -d --build minyanmate-dev
```

or:

```bash
./deploy.sh
```

Mounts:

| Host | Container |
|---|---|
| `./devbox-state/config` | `/home/node/.config` |
| `./devbox-state/data` | `/home/node/.local/share` |
| `./devbox-state/cache` | `/home/node/.cache` |
| `./devbox-state/work` | `/work` |
| `./devbox-state/ssh/hostkeys` | `/etc/ssh/dev/hostkeys` |
| `./devbox-state/ssh/authorized_keys` | `/etc/ssh/dev/authorized_keys` |
| `./devbox/devbox` | `/opt/devbox` (read-only) |
| `./secrets/opencode-go.key` | `/run/secrets/opencode_go_key` |
| `./secrets/github-dev-pat` | `/run/secrets/github_pat` |

Ports: `2222` (ACP over SSH, internal), `4096` (OpenCode HTTP API, internal),
`127.0.0.1:3100 → 3000` (preview).

---

## First boot

The entrypoint:

1. starts sshd on 2222
2. authenticates `gh` with the PAT and configures the git credential helper
3. clones or fast-forwards `harrislloydlevy/minyanmate` into `/work/minyanmate`
4. seeds `.env` from `.env.example` if missing
5. registers graphify for OpenCode
6. starts `opencode serve` on 4096 with basic auth
7. imports the OpenCode Go credential (`opencode-go` integration)
8. starts the preview on 3000

Everything except the first clone is idempotent.

---

## Gateway wiring

OpenClaw needs two things:

1. **The devbox MCP server** (stdio over SSH):

   ```
   openclaw mcp add devbox \
     --command /home/node/.config/devbox-ssh \
     --arg /usr/local/bin/node \
     --arg /opt/devbox/mcp/devbox-mcp.mjs \
     --timeout 900
   ```

2. **ACP access** (optional; `task_run` drives ACP itself, so acpx is not
   required for the pipeline):

   ```
   openclaw config set acp '{"enabled":true,"backend":"acpx","defaultAgent":"opencode","allowedAgents":["opencode"]}' --strict-json
   openclaw config set plugins.entries.acpx.config.agents.opencode \
     '{"command":"/home/node/.config/devbox-ssh","args":["opencode","acp"]}' --strict-json
   ```

The SSH wrapper lives at `gateway/devbox-ssh` in this repo. Copy it to
`/srv/docker/ocsecrets/devbox-ssh` and make it executable.

---

## Models

OpenCode Go is used for its **free tier**. `task_run` defaults to a free model
on every run and returns `free` plus `free_models`. A paid model is only used
when the caller passes `model` explicitly.

## Security

- The repository is public. It contains paths and container names, **never**
  credentials.
- The container runs with `permissions: allow *` inside OpenCode, so it can run
  shell commands and edit files. Isolation is the container boundary, not the
  agent prompt.
- The GitHub PAT is fine-grained and scoped to one repository. The agent can
  push feature branches and open PRs; it must never merge to `main`.
- The ACP SSH key is mounted only into the gateway and the container's
  `authorized_keys`.

---

## License

Private project. No license granted.
