# FryDay Code in a container: core, the built UI, the Claude Code CLI and the Linux sandbox tools.
#
#   docker compose up --build        (see docker-compose.yml and "Linux and Docker" in README.md)
#
# Agents are confined twice here: by the sandbox runtime inside the container (in its nested
# mode, see core/src/platform.ts) and by the container itself.

ARG NODE_IMAGE=node:22-bookworm-slim

# ─── Build: dependencies (better-sqlite3 is compiled here if no prebuilt binary fits) and the UI ───
FROM ${NODE_IMAGE} AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Manifests first, so a code change does not reinstall every dependency.
COPY package.json ./
COPY core/package.json core/package-lock.json ./core/
COPY ui/package.json ui/package-lock.json ./ui/
RUN npm --prefix core ci && npm --prefix ui ci
COPY . .
# The installs above are exactly the lockfiles; only the UI is built here.
RUN npm run build:ui

# ─── Run ─────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE}
# git: task branches. bubblewrap, socat, ripgrep: the sandbox (sandbox-runtime README).
# procps: ps, to stop what a command started. lsof: which addresses a service listens on.
# chromium: the UI tester's browser.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git bubblewrap socat ripgrep procps lsof chromium ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The Claude Code CLI the agents run as. Pin it with --build-arg CLAUDE_CODE_VERSION=x.y.z.
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && npm cache clean --force

WORKDIR /app
COPY --from=build --chown=root:root /app/package.json ./package.json
COPY --from=build --chown=root:root /app/core ./core
COPY docker/entrypoint.sh /usr/local/bin/fryday-entrypoint
RUN chmod 0755 /usr/local/bin/fryday-entrypoint

# Everything FryDay Code keeps, and the repositories it works on, are inside the home folder,
# which every sandbox hides from agents (apart from the task's own workspace). Keep it that
# way when you change the mounts: a folder outside /home/node is readable by agent shells.
ENV HOME=/home/node \
    FRYDAY_IN_DOCKER=1 \
    FRYDAY_HOST=0.0.0.0 \
    FRYDAY_PORT=7475 \
    FRYDAY_HOME=/home/node/.fryday-code \
    FRYDAY_CHROME=/usr/bin/chromium \
    DISABLE_AUTOUPDATER=1
RUN mkdir -p /home/node/.fryday-code /home/node/.claude /home/node/projects \
 && chown -R node:node /home/node

# Never root: the sandbox needs no privilege, and a root caller would need CAP_SETFCAP.
USER node
WORKDIR /app/core
EXPOSE 7475
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.FRYDAY_PORT||7475)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["fryday-entrypoint"]
CMD ["./node_modules/.bin/tsx", "src/server.ts"]
