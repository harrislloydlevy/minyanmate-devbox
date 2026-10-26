#!/bin/bash
set -euo pipefail

export HOME=/home/node
export PATH="/usr/local/bin:${PATH}"
export PNPM_HOME="/home/node/.local/share/pnpm"
export pnpm_config_store_dir="/home/node/.cache/pnpm-store"
export TURBO_CACHE_DIR="/home/node/.cache/turbo"
umask 077

log() { printf '[minyanmate-dev] %s\n' "$*"; }

mkdir -p "$HOME/.config/opencode" "$HOME/.local/share/opencode" \
         "$HOME/.cache/pnpm-store" "$HOME/.cache/turbo" "$HOME/.ssh" \
         /work /run/sshd /var/log
chown -R node:node "$HOME" /work 2>/dev/null || true

# ---------------------------------------------------------------- sshd (ACP)
mkdir -p /etc/ssh/dev/hostkeys
if [ ! -f /etc/ssh/dev/hostkeys/ssh_host_ed25519_key ]; then
  ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/dev/hostkeys/ssh_host_ed25519_key
fi
chmod 600 /etc/ssh/dev/hostkeys/ssh_host_ed25519_key
if [ -f /etc/ssh/dev/authorized_keys ]; then
  install -m 600 -o node -g node /etc/ssh/dev/authorized_keys "$HOME/.ssh/authorized_keys"
else
  log "WARN: no authorized_keys mounted; ACP over SSH will reject logins"
fi
/usr/sbin/sshd -f /etc/ssh/dev/sshd_config -E /var/log/sshd.log
log "sshd listening on 2222 (ACP transport)"

# ------------------------------------------------------------ github auth
if [ -s /run/secrets/github_pat ]; then
  if gosu node gh auth login --with-token < /run/secrets/github_pat >/var/log/gh.log 2>&1; then
    gosu node gh auth setup-git >>/var/log/gh.log 2>&1 || true
    log "github: authenticated as $(gosu node gh api user --jq .login 2>/dev/null || echo unknown)"
  else
    log "WARN: gh auth failed; see /var/log/gh.log"
  fi
else
  log "WARN: no GitHub PAT at /run/secrets/github_pat; clone/push/PR disabled"
fi

# --------------------------------------------------------------- repo sync
REPO=/work/minyanmate
if [ -s /run/secrets/github_pat ]; then
  if [ ! -d "$REPO/.git" ]; then
    log "cloning minyanmate -> $REPO"
    gosu node git clone --quiet https://github.com/harrislloydlevy/minyanmate.git "$REPO" \
      || log "ERROR: clone failed"
  else
    gosu node git -C "$REPO" fetch --all --prune --quiet || true
    if [ -z "$(gosu node git -C "$REPO" status --porcelain)" ]; then
      gosu node git -C "$REPO" checkout main --quiet || true
      gosu node git -C "$REPO" pull --ff-only --quiet || true
      log "repo fast-forwarded to $(gosu node git -C "$REPO" rev-parse --short HEAD)"
    else
      log "repo has local changes; skipped pull"
    fi
  fi
fi

if [ -d "$REPO/.git" ] && [ ! -f "$REPO/.env" ] && [ -f "$REPO/.env.example" ]; then
  install -m 600 -o node -g node "$REPO/.env.example" "$REPO/.env"
  log "seeded $REPO/.env from .env.example (fill in before using auth/webhooks)"
fi

# ------------------------------------------------------- graphify skill
# Per-project plugin: it writes .opencode/ inside the repo, so it needs the clone.
if command -v graphify >/dev/null 2>&1; then
  if [ -d "$REPO/.git" ]; then
    ( cd "$REPO" && gosu node graphify install --platform opencode --project ) \
      >>/var/log/graphify.log 2>&1 \
      && log "graphify registered for opencode in $REPO" \
      || log "WARN: graphify install failed; see /var/log/graphify.log"
  else
    log "graphify installed; skill registration waits for the repo clone"
  fi
fi

# ---------------------------------------------------------- opencode serve
if [ -z "${OPENCODE_SERVER_PASSWORD:-}" ]; then
  log "FATAL: OPENCODE_SERVER_PASSWORD is not set"
  exit 1
fi

gosu node env OPENCODE_DISABLE_AUTOUPDATE=1 \
  opencode serve --hostname 0.0.0.0 --port 4096 --print-logs \
  >>/var/log/opencode.log 2>&1 &
OC_PID=$!
log "opencode server starting (pid $OC_PID)"

ready=0
for _ in $(seq 1 90); do
  if curl -fsS -u "opencode:${OPENCODE_SERVER_PASSWORD}" \
       http://127.0.0.1:4096/api/info >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
if [ "$ready" != "1" ]; then
  log "FATAL: opencode server did not become ready"
  tail -30 /var/log/opencode.log || true
  exit 1
fi
log "opencode API ready: $(curl -fsS -u "opencode:${OPENCODE_SERVER_PASSWORD}" http://127.0.0.1:4096/api/info | jq -r .version)"

# ------------------------------------------------- opencode go credential
if [ -s /run/secrets/opencode_go_key ]; then
  KEY="$(cat /run/secrets/opencode_go_key)"
  # integrations load asynchronously with the models catalogue
  for _ in $(seq 1 60); do
    if curl -fsS -u "opencode:${OPENCODE_SERVER_PASSWORD}" \
         http://127.0.0.1:4096/api/integration 2>/dev/null | grep -q '"opencode-go"'; then
      break
    fi
    sleep 2
  done
  payload="$(jq -n --arg k "$KEY" '{key:$k}')"
  code="$(printf '%s' "$payload" | curl -s -o /tmp/connect.out -w '%{http_code}' \
      -u "opencode:${OPENCODE_SERVER_PASSWORD}" \
      -H 'content-type: application/json' --data-binary @- \
      http://127.0.0.1:4096/api/integration/opencode-go/connect/key)"
  log "opencode-go credential connect: HTTP $code"
  unset KEY payload
else
  log "WARN: no OpenCode Go key at /run/secrets/opencode_go_key"
fi

# --------------------------------------------------------------- preview
PREVIEW_PID=""
if [ "${PREVIEW_ENABLED:-1}" = "1" ] && [ -f "$REPO/package.json" ]; then
  if [ ! -d "$REPO/node_modules" ]; then
    log "pnpm install (first boot)"
    gosu node bash -lc "cd $REPO && pnpm install --frozen-lockfile" >>/var/log/preview.log 2>&1 \
      || gosu node bash -lc "cd $REPO && pnpm install" >>/var/log/preview.log 2>&1 \
      || log "WARN: pnpm install failed; see /var/log/preview.log"
  fi
  gosu node bash -lc "cd $REPO && exec pnpm dev" >>/var/log/preview.log 2>&1 &
  PREVIEW_PID=$!
  log "preview starting on :3000 (pid $PREVIEW_PID)"
fi

trap 'log "shutting down"; kill "$OC_PID" ${PREVIEW_PID:-} 2>/dev/null || true; [ -f /run/sshd.pid ] && kill "$(cat /run/sshd.pid)" 2>/dev/null || true; exit 0' TERM INT

log "ready"
wait -n "$OC_PID" ${PREVIEW_PID:-}
log "a managed process exited; stopping container"
exit 1
