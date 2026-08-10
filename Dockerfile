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

# Install compiler, diagnostics, document, CI, and debugging packages.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      ansible-lint \
      bash \
      btop \
      build-essential \
      ca-certificates \
      clang \
      cmake \
      curl \
      default-mysql-client \
      dnsutils \
      dumb-init \
      fd-find \
      ffmpeg \
      file \
      git \
      git-lfs \
      gnupg \
      iproute2 \
      iputils-ping \
      jq \
      less \
      libimage-exiftool-perl \
      libssl-dev \
      llvm \
      lsof \
      ltrace \
      mtr-tiny \
      ncat \
      ncdu \
      netcat-openbsd \
      ninja-build \
      openssh-client \
      pandoc \
      patch \
      pkg-config \
      poppler-utils \
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
      ssldump \
      strace \
      sysstat \
      tcpdump \
      tesseract-ocr \
      tesseract-ocr-deu \
      tree \
      unrtf \
      unzip \
      yamllint \
      yq \
      yt-dlp \
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

# Install the GitHub Actions runner for local workflow simulation.
RUN curl -sSfL https://raw.githubusercontent.com/nektos/act/master/install.sh | sh -s -- -b /usr/local/bin/act

# Install Gitleaks from its official archive because Debian Bookworm has no package.
ARG GITLEAKS_VERSION=8.30.1
RUN curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" -o /tmp/gitleaks.tar.gz \
    && tar -C /usr/local/bin -xzf /tmp/gitleaks.tar.gz gitleaks \
    && rm /tmp/gitleaks.tar.gz

RUN userdel -r node 2>/dev/null || true \
    && useradd --create-home --home-dir /home/t3 --shell /bin/bash --uid 1000 t3 \
    && mkdir -p /data /config /workspace /opt/t3-docker \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && chown -R t3:t3 /data /config /workspace /opt/t3-docker

# Create the message board directories with non-root ownership.
RUN mkdir -p /data/t3/messages/archive \
    && chown -R t3:t3 /data/t3/messages

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

# Install Python PDF text extraction support.
RUN pip install --break-system-packages pdfminer.six

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

# Install the stable Rust compiler and Cargo.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
    && . "$HOME/.cargo/env" \
    && rustup default stable
ENV PATH="$HOME/.cargo/bin:$PATH"

# Install the final Go 1.22 patch release because the minor-only URL does not exist.
RUN curl -fsSL https://go.dev/dl/go1.22.12.linux-amd64.tar.gz -o /tmp/go.tar.gz \
    && tar -C /usr/local -xzf /tmp/go.tar.gz \
    && rm /tmp/go.tar.gz
ENV PATH="/usr/local/go/bin:$PATH"

ARG T3_VERSION=latest

RUN --mount=type=cache,target=/tmp/npm-cache \
    T3_DOCKER_KEEP_NPM_CACHE=1 T3_DOCKER_NPM_CACHE_DIR=/tmp/npm-cache T3_DOCKER_INSTALL_TARGET=t3 T3_VERSION="${T3_VERSION}" /opt/t3-docker/install-provider-clis.sh \
    && chown -R t3:t3 /data

COPY --chown=t3:t3 scripts/render-config.py /opt/t3-docker/render-config.py
COPY --chown=t3:t3 scripts/entrypoint.sh /opt/t3-docker/entrypoint.sh
# Install the message cleanup utility.
COPY --chown=t3:t3 scripts/cleanup-messages.sh /opt/t3-docker/cleanup-messages.sh
COPY --chown=t3:t3 scripts/healthcheck.sh /opt/t3-docker/healthcheck.sh
COPY --chown=t3:t3 scripts/auth-proxy.mjs /opt/t3-docker/auth-proxy.mjs
COPY --chown=t3:t3 scripts/harness-auth.sh /opt/t3-docker/harness-auth.sh
COPY --chown=t3:t3 scripts/provision-opencode-mcp.mjs /opt/t3-docker/provision-opencode-mcp.mjs
COPY --chown=t3:t3 scripts/provision-harness-mcp.sh /opt/t3-docker/provision-harness-mcp.sh
COPY --chown=t3:t3 scripts/provision-harness-instructions.py /opt/t3-docker/provision-harness-instructions.py
COPY --chown=t3:t3 scripts/provision-ste100-policy.py /opt/t3-docker/provision-ste100-policy.py
COPY --chown=t3:t3 scripts/configure-codex-mcp.py /opt/t3-docker/configure-codex-mcp.py
COPY --chown=t3:t3 scripts/configure-cursor-mcp.mjs /opt/t3-docker/configure-cursor-mcp.mjs
COPY --chown=t3:t3 scripts/cursor-sandbox-wrapper.mjs /opt/t3-docker/cursor-sandbox-wrapper.mjs
COPY --chown=t3:t3 scripts/claude-launcher.sh /opt/t3-docker/claude-launcher.sh
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
COPY --chown=t3:t3 agent-assets /opt/t3-docker/agent-assets
COPY --chown=t3:t3 vendor/asd-ste100 /opt/t3-docker/vendor/asd-ste100

# Make the message cleanup command executable.
RUN chmod +x /opt/t3-docker/cleanup-messages.sh

RUN chmod +x /opt/t3-docker/render-config.py /opt/t3-docker/entrypoint.sh /opt/t3-docker/healthcheck.sh /opt/t3-docker/auth-proxy.mjs /opt/t3-docker/harness-auth.sh /opt/t3-docker/provision-opencode-mcp.mjs /opt/t3-docker/provision-harness-mcp.sh /opt/t3-docker/provision-harness-instructions.py /opt/t3-docker/provision-ste100-policy.py /opt/t3-docker/configure-codex-mcp.py /opt/t3-docker/configure-cursor-mcp.mjs /opt/t3-docker/claude-launcher.sh /opt/t3-docker/t3-sandbox-mcp.mjs /opt/t3-docker/t3-xcode-mcp.mjs /opt/t3-docker/t3-xcode-auth.sh /opt/t3-docker/t3-doctor.sh /opt/t3-docker/github-issue-worker.mjs /opt/t3-docker/github-git-askpass.sh /opt/t3-docker/issue-worker-entrypoint.sh \
    && mkdir -p /opt/t3-docker/runtime-bin \
    && ln -s /opt/t3-docker/claude-launcher.sh /opt/t3-docker/runtime-bin/claude \
    && ln -s /opt/t3-docker/harness-auth.sh /usr/local/bin/t3-auth \
    && ln -s /opt/t3-docker/t3-sandbox-mcp.mjs /usr/local/bin/t3-sandbox-mcp \
    && ln -s /opt/t3-docker/t3-xcode-mcp.mjs /usr/local/bin/t3-xcode-mcp \
    && ln -s /opt/t3-docker/t3-xcode-auth.sh /usr/local/bin/t3-xcode-auth \
    && ln -s /opt/t3-docker/t3-doctor.sh /usr/local/bin/t3-doctor \
    && ln -s /opt/t3-docker/cursor-sandbox-wrapper.mjs /usr/local/bin/t3-cursor-agent \
    && ln -s /opt/t3-docker/github-issue-worker.mjs /usr/local/bin/t3-issue-worker

# Fail the build if a requested tool is not available.
RUN for binary in \
      act \
      ansible-lint \
      btop \
      cargo \
      clang \
      cmake \
      exiftool \
      ffmpeg \
      g++ \
      gcc \
      gitleaks \
      go \
      ldd \
      ltrace \
      mtr \
      ncat \
      ncdu \
      ninja \
      pandoc \
      pdftotext \
      rustc \
      sar \
      ssldump \
      tcpdump \
      tesseract \
      unrtf \
      yamllint \
      yt-dlp; do \
        command -v "$binary"; \
    done

ARG T3_BUILD_NUMBER=1

ENV T3_IMAGE_T3_VERSION=${T3_VERSION} \
    T3_IMAGE_BUILD_NUMBER=${T3_BUILD_NUMBER}

LABEL org.opencontainers.image.version="${T3_VERSION}-${T3_BUILD_NUMBER}"

USER t3
WORKDIR /workspace

EXPOSE 3773

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD ["/opt/t3-docker/healthcheck.sh"]

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/opt/t3-docker/entrypoint.sh"]
