# syntax=docker/dockerfile:1.7

FROM node:26-bookworm-slim

ARG T3_VERSION=latest

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
      dumb-init \
      fd-find \
      git \
      jq \
      openssh-client \
      procps \
      python3 \
      ripgrep \
      rsync

RUN --mount=type=cache,target=/data/npm-cache \
    npm install -g npm@latest

RUN userdel -r node 2>/dev/null || true \
    && useradd --create-home --home-dir /home/t3 --shell /bin/bash --uid 1000 t3 \
    && mkdir -p /data /config /workspace /opt/t3-docker \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && chown -R t3:t3 /data /config /workspace /opt/t3-docker

COPY scripts/install-provider-clis.sh /opt/t3-docker/install-provider-clis.sh

RUN --mount=type=cache,target=/tmp/npm-cache \
    chmod +x /opt/t3-docker/install-provider-clis.sh \
    && T3_DOCKER_KEEP_NPM_CACHE=1 T3_DOCKER_NPM_CACHE_DIR=/tmp/npm-cache T3_VERSION="${T3_VERSION}" /opt/t3-docker/install-provider-clis.sh \
    && chown -R t3:t3 /data

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update \
    && apt-get install -y --no-install-recommends gnupg \
    && mkdir -p -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh

COPY --chown=t3:t3 scripts/render-config.py /opt/t3-docker/render-config.py
COPY --chown=t3:t3 scripts/entrypoint.sh /opt/t3-docker/entrypoint.sh
COPY --chown=t3:t3 scripts/healthcheck.sh /opt/t3-docker/healthcheck.sh
COPY --chown=t3:t3 scripts/auth-proxy.mjs /opt/t3-docker/auth-proxy.mjs
COPY --chown=t3:t3 scripts/harness-auth.sh /opt/t3-docker/harness-auth.sh
COPY --chown=t3:t3 scripts/provision-opencode-mcp.mjs /opt/t3-docker/provision-opencode-mcp.mjs

RUN chmod +x /opt/t3-docker/render-config.py /opt/t3-docker/entrypoint.sh /opt/t3-docker/healthcheck.sh /opt/t3-docker/auth-proxy.mjs /opt/t3-docker/harness-auth.sh /opt/t3-docker/provision-opencode-mcp.mjs \
    && ln -s /opt/t3-docker/harness-auth.sh /usr/local/bin/t3-auth

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
