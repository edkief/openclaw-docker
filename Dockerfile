# Multi-stage Dockerfile for OpenClaw

# pin base image
#FROM node:22-bookworm@sha256:cd7bcd2e7a1e6f72052feb023c7f6b722205d3fcab7bbcbd2d1bfdab10b1e935 AS pinned-node
#FROM node:24-bookworm AS pinned-node
FROM node:25-bookworm AS pinned-node


# --- Stage 1: Base ---
FROM pinned-node AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN npm i -g pnpm
RUN pnpm -v

FROM base as source
WORKDIR /app
RUN git clone https://github.com/openclaw/openclaw.git /app && git -C /app checkout $(git -C /app tag --sort=-version:refname | grep -vi 'beta' | head -n 1)
COPY patches/telegram_probe_timeout.patch ./ 
RUN patch -p1 < telegram_probe_timeout.patch || echo "Patch failed, moving on..."
RUN git rev-parse HEAD > git-rev.txt && git log -n 20 > git-log.txt

# --- Stage 2: Prod Dependencies ---
FROM base AS prod-deps
WORKDIR /app
COPY --from=source /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/.npmrc ./
COPY --from=source /app/scripts ./scripts
COPY --from=source /app/ui/package.json ./ui/package.json
COPY --from=source /app/patches ./patches
# Install only production dependencies
# --ignore-scripts is risky for native modules (sharp, sqlite), so we run scripts.
RUN pnpm install --prod --frozen-lockfile

# --- Stage 3: Builder ---
FROM base AS builder
WORKDIR /app
# Install Bun (required for build scripts per original Dockerfile)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"
# Install all dependencies (including dev)
COPY --from=source /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/.npmrc ./
COPY --from=source /app/ui/package.json ./ui/package.json
COPY --from=source /app/patches ./patches
COPY --from=source /app/scripts ./scripts
RUN pnpm install --frozen-lockfile
# Copy source code
COPY --from=source /app .
# Build Backend
RUN OPENCLAW_A2UI_SKIP_MISSING=1 pnpm build
# Build UI (outputs to dist/control-ui)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

# --- Stage 4: Runner ---
FROM pinned-node AS runner
WORKDIR /app

# Install optional system packages
ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/*; \
    fi

ENV NODE_ENV=production

# Copy production node_modules
COPY --from=prod-deps /app/node_modules /app/node_modules

# Copy built artifacts and necessary assets
COPY --from=builder /app/dist /app/dist
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/docs /app/docs
COPY --from=builder /app/extensions /app/extensions
COPY --from=builder /app/skills /app/skills
COPY --from=builder /app/scripts /app/scripts

COPY --from=source /app/git-rev.txt /app/git-rev.txt
COPY --from=source /app/git-log.txt /app/git-log.txt

# Install basic tools + Filebrowser + TTYD
RUN curl -s "https://dl.google.com/go/go1.25.6.linux-amd64.tar.gz" | tar -C /usr/local -xz && ln -s /usr/local/go/bin/go /usr/bin/go

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates nano vim build-essential procps file git ffmpeg python3-venv \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://github.com/filebrowser/filebrowser/releases/latest/download/linux-amd64-filebrowser.tar.gz | tar -xz -C /usr/local/bin filebrowser \
    && chmod +x /usr/local/bin/filebrowser

RUN curl -fsSL -o /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 \
    && chmod +x /usr/local/bin/ttyd 

## Requires another PVC if using default /home/linuxbrew install folder, disabling for now
#RUN NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
#    && chown -R 1000 /home/linuxbrew

RUN npm install -g pnpm && npm install -g @google/gemini-cli

# Copy custom startup script (Assuming you placed it in scripts/ locally)
# If not, you can create it via RUN command here:
COPY start-workspace.sh /app/start-workspace.sh
COPY init-workspace.sh /app/init-workspace.sh
COPY start-openclaw.sh /app/start-openclaw.sh
RUN chmod +x /app/start-workspace.sh /app/init-workspace.sh /app/start-openclaw.sh

# Create non-root user (node user exists in image)
USER node

# Default command
CMD ["/bin/bash", "-c", "/app/init-workspace.sh && /app/start-workspace.sh"]
