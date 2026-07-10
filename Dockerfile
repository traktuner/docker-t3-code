# syntax=docker/dockerfile:1.7

FROM node:26-bookworm-slim

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG MCP_SDK_VERSION=1.29.0
ARG ZOD_VERSION=4.4.3
ARG NPM_VERSION=latest
ARG PNPM_VERSION=latest
ARG YARN_VERSION=latest
ARG PRETTIER_VERSION=latest
ARG TYPESCRIPT_VERSION=latest
ARG TSX_VERSION=latest
ARG UV_VERSION=latest
ARG UV_INSTALLER_SHA256=""
ARG BUN_VERSION=latest
ARG BUN_INSTALLER_SHA256=""

ENV DEBIAN_FRONTEND=noninteractive \
    T3CODE_HOME=/data/t3 \
    T3CODE_CONFIG_PATH=/config/t3code.toml \
    HOME=/data/home \
    CODEX_HOME=/data/codex \
    GROK_CONFIG_DIR=/data/home/.grok \
    XDG_CONFIG_HOME=/data/home/.config \
    XDG_DATA_HOME=/data/home/.local/share \
    XDG_CACHE_HOME=/data/home/.cache \
    NPM_CONFIG_PREFIX=/data/npm-global \
    npm_config_prefix=/data/npm-global \
    NPM_CONFIG_CACHE=/data/npm-cache \
    npm_config_cache=/data/npm-cache \
    PATH=/data/npm-global/bin:/data/home/.local/bin:/data/home/.grok/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      build-essential \
      ca-certificates \
      curl \
      default-mysql-client \
      dumb-init \
      dnsutils \
      fd-find \
      file \
      git \
      git-lfs \
      gnupg \
      iproute2 \
      iputils-ping \
      jq \
      less \
      lsof \
      netcat-openbsd \
      openssh-client \
      patch \
      pkg-config \
      postgresql-client \
      procps \
      python3 \
      python3-pip \
      python3-tomlkit \
      python3-venv \
      redis-tools \
      ripgrep \
      rsync \
      shellcheck \
      sqlite3 \
      strace \
      tree \
      unzip \
      yq \
      zip

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    mkdir -p -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh

RUN userdel -r node 2>/dev/null || true \
    && useradd --create-home --home-dir /home/t3 --shell /bin/bash --uid 1000 t3 \
    && mkdir -p /data /config /workspace /opt/t3-docker \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && chown -R t3:t3 /data /config /workspace /opt/t3-docker

COPY scripts/install-provider-clis.sh /opt/t3-docker/install-provider-clis.sh

ARG CODEX_VERSION=latest
ARG CLAUDE_VERSION=latest
ARG OPENCODE_VERSION=latest
ARG CURSOR_INSTALLER_SHA256=""
ARG GROK_INSTALLER_SHA256=""
ARG GROK_VERSION=""

RUN --mount=type=cache,target=/tmp/npm-cache \
    chmod +x /opt/t3-docker/install-provider-clis.sh \
    && T3_DOCKER_KEEP_NPM_CACHE=1 T3_DOCKER_NPM_CACHE_DIR=/tmp/npm-cache T3_DOCKER_INSTALL_TARGET=providers CODEX_VERSION="${CODEX_VERSION}" CLAUDE_VERSION="${CLAUDE_VERSION}" OPENCODE_VERSION="${OPENCODE_VERSION}" CURSOR_INSTALLER_SHA256="${CURSOR_INSTALLER_SHA256}" GROK_INSTALLER_SHA256="${GROK_INSTALLER_SHA256}" GROK_VERSION="${GROK_VERSION}" /opt/t3-docker/install-provider-clis.sh \
    && chown -R t3:t3 /data

RUN --mount=type=cache,target=/data/npm-cache \
    npm install -g --prefix /usr/local \
      "npm@${NPM_VERSION}" \
      "pnpm@${PNPM_VERSION}" \
      "yarn@${YARN_VERSION}" \
      "prettier@${PRETTIER_VERSION}" \
      "typescript@${TYPESCRIPT_VERSION}" \
      "tsx@${TSX_VERSION}" \
    && npm install --prefix /opt/t3-docker --no-audit --no-fund \
      "@modelcontextprotocol/sdk@${MCP_SDK_VERSION}" \
      "zod@${ZOD_VERSION}"

RUN uv_installer="$(mktemp)" \
    && if [[ "$UV_VERSION" == "latest" ]]; then \
         uv_installer_url=https://astral.sh/uv/install.sh; \
       else \
         uv_installer_url="https://astral.sh/uv/${UV_VERSION}/install.sh"; \
       fi \
    && curl -fsSL "$uv_installer_url" -o "$uv_installer" \
    && if [[ -n "$UV_INSTALLER_SHA256" ]]; then \
         printf '%s  %s\n' "$UV_INSTALLER_SHA256" "$uv_installer" | sha256sum --check --status; \
       fi \
    && env UV_INSTALL_DIR=/usr/local/bin sh "$uv_installer" \
    && rm -f "$uv_installer" \
    && for bin in /usr/local/bin/uv /usr/local/bin/uvx; do \
      [ ! -e "$bin" ] || chmod +x "$bin"; \
    done

RUN bun_installer="$(mktemp)" \
    && curl -fsSL https://bun.sh/install -o "$bun_installer" \
    && if [[ -n "$BUN_INSTALLER_SHA256" ]]; then \
         printf '%s  %s\n' "$BUN_INSTALLER_SHA256" "$bun_installer" | sha256sum --check --status; \
       fi \
    && if [[ "$BUN_VERSION" == "latest" ]]; then bun_version_args=(); \
       else bun_version_args=("bun-v${BUN_VERSION}"); fi \
    && env BUN_INSTALL=/usr/local bash "$bun_installer" "${bun_version_args[@]}" \
    && rm -f "$bun_installer" \
    && for bin in /usr/local/bin/bun /usr/local/bin/bunx; do \
      [ ! -e "$bin" ] || chmod +x "$bin"; \
    done

ARG T3_VERSION=latest

RUN --mount=type=cache,target=/tmp/npm-cache \
    T3_DOCKER_KEEP_NPM_CACHE=1 T3_DOCKER_NPM_CACHE_DIR=/tmp/npm-cache T3_DOCKER_INSTALL_TARGET=t3 T3_VERSION="${T3_VERSION}" /opt/t3-docker/install-provider-clis.sh \
    && chown -R t3:t3 /data

COPY --chown=t3:t3 scripts/render-config.py /opt/t3-docker/render-config.py
COPY --chown=t3:t3 scripts/entrypoint.sh /opt/t3-docker/entrypoint.sh
COPY --chown=t3:t3 scripts/healthcheck.sh /opt/t3-docker/healthcheck.sh
COPY --chown=t3:t3 scripts/auth-proxy.mjs /opt/t3-docker/auth-proxy.mjs
COPY --chown=t3:t3 scripts/mcp-auth-helper.mjs /opt/t3-docker/mcp-auth-helper.mjs
COPY --chown=t3:t3 scripts/harness-auth.sh /opt/t3-docker/harness-auth.sh
COPY --chown=t3:t3 scripts/provision-opencode-mcp.mjs /opt/t3-docker/provision-opencode-mcp.mjs
COPY --chown=t3:t3 scripts/provision-harness-mcp.sh /opt/t3-docker/provision-harness-mcp.sh
COPY --chown=t3:t3 scripts/configure-codex-mcp.py /opt/t3-docker/configure-codex-mcp.py
COPY --chown=t3:t3 scripts/configure-cursor-mcp.mjs /opt/t3-docker/configure-cursor-mcp.mjs
COPY --chown=t3:t3 scripts/t3-sandbox-mcp.mjs /opt/t3-docker/t3-sandbox-mcp.mjs
COPY --chown=t3:t3 scripts/t3-xcode-mcp.mjs /opt/t3-docker/t3-xcode-mcp.mjs
COPY --chown=t3:t3 scripts/t3-xcode-auth.sh /opt/t3-docker/t3-xcode-auth.sh
COPY --chown=t3:t3 scripts/t3-doctor.sh /opt/t3-docker/t3-doctor.sh
COPY --chown=t3:t3 scripts/github-issue-worker-lib.mjs /opt/t3-docker/github-issue-worker-lib.mjs
COPY --chown=t3:t3 scripts/github-issue-worker.mjs /opt/t3-docker/github-issue-worker.mjs
COPY --chown=t3:t3 scripts/github-issue-worker-agent.md /opt/t3-docker/github-issue-worker-agent.md
COPY --chown=t3:t3 scripts/github-git-askpass.sh /opt/t3-docker/github-git-askpass.sh
COPY --chown=t3:t3 scripts/issue-worker-entrypoint.sh /opt/t3-docker/issue-worker-entrypoint.sh
COPY --chown=t3:t3 scripts/t3-sandbox-instructions.md /opt/t3-docker/t3-sandbox-instructions.md
COPY --chown=t3:t3 scripts/t3-sandbox-only-plugin.js /opt/t3-docker/t3-sandbox-only-plugin.js

RUN chmod +x /opt/t3-docker/render-config.py /opt/t3-docker/entrypoint.sh /opt/t3-docker/healthcheck.sh /opt/t3-docker/auth-proxy.mjs /opt/t3-docker/mcp-auth-helper.mjs /opt/t3-docker/harness-auth.sh /opt/t3-docker/provision-opencode-mcp.mjs /opt/t3-docker/provision-harness-mcp.sh /opt/t3-docker/configure-codex-mcp.py /opt/t3-docker/configure-cursor-mcp.mjs /opt/t3-docker/t3-sandbox-mcp.mjs /opt/t3-docker/t3-xcode-mcp.mjs /opt/t3-docker/t3-xcode-auth.sh /opt/t3-docker/t3-doctor.sh /opt/t3-docker/github-issue-worker.mjs /opt/t3-docker/github-git-askpass.sh /opt/t3-docker/issue-worker-entrypoint.sh \
    && ln -s /opt/t3-docker/harness-auth.sh /usr/local/bin/t3-auth \
    && ln -s /opt/t3-docker/t3-sandbox-mcp.mjs /usr/local/bin/t3-sandbox-mcp \
    && ln -s /opt/t3-docker/t3-xcode-mcp.mjs /usr/local/bin/t3-xcode-mcp \
    && ln -s /opt/t3-docker/t3-xcode-auth.sh /usr/local/bin/t3-xcode-auth \
    && ln -s /opt/t3-docker/t3-doctor.sh /usr/local/bin/t3-doctor \
    && ln -s /opt/t3-docker/github-issue-worker.mjs /usr/local/bin/t3-issue-worker

ARG T3_BUILD_NUMBER=1

ENV T3_IMAGE_T3_VERSION=${T3_VERSION} \
    T3_IMAGE_BUILD_NUMBER=${T3_BUILD_NUMBER}

LABEL org.opencontainers.image.version="${T3_VERSION}-${T3_BUILD_NUMBER}"

USER t3
WORKDIR /workspace

EXPOSE 3773 13774

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD ["/opt/t3-docker/healthcheck.sh"]

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/opt/t3-docker/entrypoint.sh"]
