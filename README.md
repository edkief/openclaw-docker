# OpenClaw augmented Docker image

This repository builds an **augmented OpenClaw Docker image** that bundles [OpenClaw](https://github.com/openclaw/openclaw) with **Filebrowser** and **ttyd**. A single container provides:

| Service      | Port  | Description |
|-------------|-------|-------------|
| OpenClaw gateway | 18789 | Main OpenClaw API/gateway |
| Filebrowser | 8081  | Web file manager for the workspace (path configurable via `FILEBROWSER_BASE_URL`) |
| ttyd        | 8082  | In-browser terminal |

This all-in-one image simplifies deployment in **multi-tenant environments** (e.g. Kubernetes), where each tenant gets one pod with IDE-like file access and a shell without extra sidecar containers.

---

## Prerequisites

- **Docker** (with BuildKit recommended)
- For Kubernetes: `kubectl` and a cluster

---

## Quick start: build the image

### Option 1: Use the build script (build + push)

```bash
# Build and push to the default registry (see below for customizing)
./build-docker.sh
```

Default image name: `localhost/openclaw-gateway:latest`. Override with:

```bash
OPENCLAW_IMAGE=your-registry.io/your-org/openclaw-gateway:v1 ./build-docker.sh
```

Pass extra Docker build arguments after the script name, e.g.:

```bash
./build-docker.sh --no-cache
```

### Option 2: Plain Docker build (no push)

```bash
docker build -t openclaw-gateway:local -f Dockerfile .
```

Optional build-time customization:

```bash
# Install extra APT packages in the image
docker build \
  --build-arg OPENCLAW_DOCKER_APT_PACKAGES="git,rsync" \
  -t openclaw-gateway:local \
  -f Dockerfile .
```

---

## What runs inside the container

The image runs as the **`node`** user. At startup, `start-workspace.sh`:

1. Starts **Filebrowser** on port **8081**, serving `/home/node/.openclaw/workspace`. If `FILEBROWSER_BASE_URL` is set (e.g. `/workspace`), it is passed as `--baseURL`; otherwise Filebrowser serves at root. Optional `FILEBROWSER_EXTRA_ARGS` can add more flags. No auth by default (see [Security](#security)).
2. Starts **ttyd** on port **8082**, offering a bash session in the browser.
3. Starts the **OpenClaw gateway** on port **18789** (bind and port are configurable via the script if you customize it).

Persistent data lives under `/home/node/.openclaw` (config and workspace). Mount a volume there so state survives restarts.

---

## Deployment on Kubernetes (multi-tenant)

For multi-tenant setups (e.g. one Deployment per tenant/namespace), use one pod per tenant and expose the three services.

### Ports to expose

| Container port | Protocol | Typical use |
|----------------|----------|-------------|
| 18789 | TCP | OpenClaw gateway (CLI/API) |
| 8081  | TCP | Filebrowser UI |
| 8082  | TCP | ttyd web terminal |

### Volumes

- **Workspace/config**: mount a **PersistentVolumeClaim** (or similar) at `/home/node` or at least:
  - `/home/node/.openclaw` — config
  - `/home/node/.openclaw/workspace` — files visible in Filebrowser and in the terminal

Example pod template snippet:

```yaml
spec:
  containers:
    - name: openclaw-gateway
      image: your-registry.io/your-org/openclaw-gateway:latest
      ports:
        - name: gateway
          containerPort: 18789
        - name: filebrowser
          containerPort: 8081
        - name: ttyd
          containerPort: 8082
      env:
        # Required when Ingress/reverse proxy serves Filebrowser under a path (e.g. /workspace)
        - name: FILEBROWSER_BASE_URL
          value: "/workspace"
      volumeMounts:
        - name: openclaw-data
          mountPath: /home/node/.openclaw
  volumes:
    - name: openclaw-data
      persistentVolumeClaim:
        claimName: openclaw-workspace-pvc  # one PVC per tenant
```

### Ingress / routing

- Expose **18789** for OpenClaw (gateway/API).
- Expose **8081** for Filebrowser. **When using a reverse proxy (Ingress, nginx, Traefik, etc.) with path-based routing**, you **must** set **`FILEBROWSER_BASE_URL`** to the path the proxy uses (e.g. `/workspace`). Otherwise Filebrowser generates wrong URLs for assets and links and the UI breaks (404s, wrong redirects). Example: if the proxy serves Filebrowser at `https://example.com/workspace`, set `FILEBROWSER_BASE_URL=/workspace` in the container env.
- Expose **8082** for ttyd (e.g. `/terminal` or a subdomain per tenant).

Use Ingress, Route, or a per-tenant Service so each tenant has isolated URLs and backends.

### Reverse proxy and Filebrowser base URL

Filebrowser must know the base path when it is served behind a reverse proxy. If the proxy strips a path prefix or serves Filebrowser under a subpath (e.g. `/workspace`), set **`FILEBROWSER_BASE_URL`** in the container environment to that path (e.g. `FILEBROWSER_BASE_URL=/workspace`). Without this, Filebrowser assumes it is at the root and builds incorrect URLs for static assets and navigation, which causes broken pages and 404s. This is a common source of issues when deploying behind Ingress or other proxies.

### Resource limits

Set `resources.requests`/`limits` per tenant (CPU/memory) so multi-tenancy stays fair and predictable.

---

## Environment and build customization

**Build** — Used by `build-docker.sh` (env vars; image name can be overridden via `OPENCLAW_IMAGE`). For Kubernetes, set runtime env in the Deployment.

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_IMAGE` | `localhost/openclaw-gateway:latest` | Image name for build/push |
| `OPENCLAW_DOCKER_APT_PACKAGES` | (empty) | Extra APT packages in image, build-arg (comma-separated) |

**Runtime (container env)** — Set in the pod/container when running the image (e.g. Kubernetes Deployment `env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `FILEBROWSER_BASE_URL` | (unset) | **Required when behind a reverse proxy.** Base path Filebrowser is served under (e.g. `/workspace`). Passed as `--baseURL`. If unset, Filebrowser serves at root; behind a path-based proxy this causes broken assets and 404s. |
| `FILEBROWSER_EXTRA_ARGS` | (unset) | Optional extra arguments for Filebrowser (e.g. `--prefix /files`). Omitted if unset. |

Build-arg for the Dockerfile:

- **`OPENCLAW_DOCKER_APT_PACKAGES`** — e.g. `git,rsync` to add tools to the image.

---

## Security

- The image runs as **non-root** (`node`).
- Filebrowser is started with **`--noauth`** in `start-workspace.sh` for simplicity in demo/k8s setups. **In production**, remove `--noauth` and configure authentication (default admin credentials or your own) so only authorized users can access the file UI.
- For multi-tenant Kubernetes, enforce isolation with namespaces, network policies, and separate PVCs per tenant. Restrict who can access Services/Ingresses that expose ports 8081 and 8082.

---

## Repository layout

| File / dir       | Purpose |
|------------------|---------|
| `Dockerfile`     | Multi-stage build: OpenClaw + Filebrowser + ttyd |
| `start-workspace.sh` | Entrypoint: starts filebrowser (with optional `FILEBROWSER_BASE_URL` / `FILEBROWSER_EXTRA_ARGS`), ttyd, then OpenClaw gateway |
| `build-docker.sh`    | Builds image, pushes to `OPENCLAW_IMAGE` (from env or default) |

---

## License and upstream

- OpenClaw: [github.com/openclaw/openclaw](https://github.com/openclaw/openclaw)
- Filebrowser: [github.com/filebrowser/filebrowser](https://github.com/filebrowser/filebrowser)
- ttyd: [github.com/tsl0922/ttyd](https://github.com/tsl0922/ttyd)

This build repo only adds Docker and startup glue; licensing follows the respective upstream projects.
