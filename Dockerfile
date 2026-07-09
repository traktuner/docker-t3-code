FROM node:26-bookworm-slim

ARG T3_VERSION=latest
ARG T3_BUILD_NUMBER=1

ENV DEBIAN_FRONTEND=noninteractive \
    T3_IMAGE_T3_VERSION=${T3_VERSION} \
    T3_IMAGE_BUILD_NUMBER=${T3_BUILD_NUMBER} \
    T3CODE_HOME=/data/t3 \
    T3CODE_CONFIG_PATH=/config/t3code.toml \
    HOME=/data/home \
    CODEX_HOME=/data/codex \
    XDG_CONFIG_HOME=/data/home/.config \
    XDG_DATA_HOME=/data/home/.local/share \
    XDG_CACHE_HOME=/data/home/.cache \
    NPM_CONFIG_PREFIX=/data/npm-global \
    npm_config_prefix=/data/npm-global \
    NPM_CONFIG_CACHE=/data/npm-cache \
    npm_config_cache=/data/npm-cache \
    PATH=/data/npm-global/bin:/data/home/.local/bin:/data/home/.grok/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

LABEL org.opencontainers.image.version="${T3_VERSION}-${T3_BUILD_NUMBER}"

RUN apt-get update \
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
      tini \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g npm@latest \
    && npm cache clean --force

RUN userdel -r node 2>/dev/null || true \
    && useradd --create-home --home-dir /home/t3 --shell /bin/bash --uid 1000 t3 \
    && mkdir -p /data /config /workspace /opt/t3-docker \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && chown -R t3:t3 /data /config /workspace /opt/t3-docker

COPY scripts/install-provider-clis.sh /opt/t3-docker/install-provider-clis.sh

RUN chmod +x /opt/t3-docker/install-provider-clis.sh \
    && T3_VERSION="${T3_VERSION}" /opt/t3-docker/install-provider-clis.sh \
    && chown -R t3:t3 /data

COPY --chown=t3:t3 scripts/render-config.py /opt/t3-docker/render-config.py
COPY --chown=t3:t3 scripts/entrypoint.sh /opt/t3-docker/entrypoint.sh
COPY --chown=t3:t3 scripts/healthcheck.sh /opt/t3-docker/healthcheck.sh
COPY --chown=t3:t3 scripts/auth-proxy.mjs /opt/t3-docker/auth-proxy.mjs

RUN chmod +x /opt/t3-docker/render-config.py /opt/t3-docker/entrypoint.sh /opt/t3-docker/healthcheck.sh /opt/t3-docker/auth-proxy.mjs

USER t3
WORKDIR /workspace

EXPOSE 3773

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD ["/opt/t3-docker/healthcheck.sh"]

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/opt/t3-docker/entrypoint.sh"]
