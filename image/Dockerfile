# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim

ARG OPENCODE_VERSION=2.1.2
ARG GRAPHIFY_VERSION=latest

ENV DEBIAN_FRONTEND=noninteractive \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_HOME=/usr/local/bin

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq less procps \
      openssh-server openssh-client \
      python3 python3-venv \
      make g++ pkg-config \
      gosu tini \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI (official apt repo)
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# pnpm (repo pins it via packageManager; corepack shim honours that)
RUN corepack enable && corepack prepare pnpm@10 --activate

# OpenCode v2 CLI (v2 package is @opencode/cli, not opencode-ai)
RUN npm install -g --no-audit --no-fund "@opencode/cli@${OPENCODE_VERSION}" \
    && opencode --version

# uv + graphify CLI (knowledge-graph skill for OpenCode)
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
    && UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin \
       uv tool install "graphifyy@${GRAPHIFY_VERSION}" \
    && graphify --version || true

# sshd rejects accounts whose shadow entry is locked (!); key-only auth is enforced
# by PasswordAuthentication no, so unlock the account without setting a password.
RUN passwd -d node

# ACP host keys + authorized_keys are mounted at /etc/ssh/dev
COPY sshd_config /etc/ssh/dev/sshd_config
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh \
    && mkdir -p /run/sshd /work /var/log \
    && chown -R node:node /home/node

EXPOSE 2222 4096 3000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
