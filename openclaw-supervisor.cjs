#!/usr/bin/env node

/**
 * OpenClaw supervisor
 *
 * - Runs `node dist/index.js doctor`
 * - If doctor succeeds, runs `node dist/index.js gateway --bind lan --port 18789 --allow-unconfigured`
 * - If either step fails or the gateway exits, starts a fallback HTTP server on port 18789
 *   that shows the error stage, exit code, and captured logs, and exposes POST /restart
 *   which exits the process so Kubernetes can restart the pod.
 */

const http = require("http");
const { spawn } = require("child_process");

// Resolve bind/port from CLI args first, then env, then defaults.
const argv = process.argv.slice(2);
let cliPort = null;
let cliBind = null;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--port" && i + 1 < argv.length) {
    const n = parseInt(argv[++i], 10);
    if (Number.isFinite(n) && n >= 0 && n < 65536) {
      cliPort = n;
    }
  } else if (arg === "--bind" && i + 1 < argv.length) {
    cliBind = argv[++i];
  }
}

function resolvePort() {
  if (cliPort !== null) return cliPort;
  const raw = process.env.OPENCLAW_GATEWAY_PORT;
  if (raw != null && raw !== "") {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0 && n < 65536) return n;
  }
  return 18789;
}

const GATEWAY_PORT = resolvePort();
const GATEWAY_BIND = cliBind || process.env.OPENCLAW_GATEWAY_BIND || "lan";

const MAX_LOG_BYTES = 200 * 1024; // keep last 200KB per phase

/** Simple rolling buffer for logs */
class RollingLogBuffer {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this._buf = "";
  }

  append(chunk) {
    const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this._buf += str;
    if (this._buf.length > this.maxBytes) {
      this._buf = this._buf.slice(this._buf.length - this.maxBytes);
    }
  }

  toString() {
    return this._buf;
  }
}

/** Shared state exposed to the fallback UI */
const state = {
  mode: "starting", // "starting" | "running" | "fallback"
  stage: "doctor", // "doctor" | "gateway"
  failureStage: null, // "doctor" | "gateway" | null
  failureExitCode: null,
  failureSignal: null,
};

const doctorLog = new RollingLogBuffer(MAX_LOG_BYTES);
const gatewayLog = new RollingLogBuffer(MAX_LOG_BYTES);

function logSupervisor(message) {
  const ts = new Date().toISOString();
  process.stdout.write(`[supervisor ${ts}] ${message}\n`);
}

function runDoctor() {
  return new Promise((resolve) => {
    state.stage = "doctor";
    logSupervisor("Running OpenClaw doctor ...");

    const child = spawn("node", ["dist/index.js", "doctor"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      doctorLog.append(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      doctorLog.append(chunk);
    });

    child.on("error", (err) => {
      logSupervisor(`Failed to spawn doctor: ${err.message}`);
      state.mode = "fallback";
      state.failureStage = "doctor";
      state.failureExitCode = 1;
      state.failureSignal = null;
      resolve(false);
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        logSupervisor("Doctor completed successfully.");
        resolve(true);
      } else {
        logSupervisor(
          `Doctor failed with code=${code} signal=${signal || "null"}`
        );
        state.mode = "fallback";
        state.failureStage = "doctor";
        state.failureExitCode = code;
        state.failureSignal = signal;
        resolve(false);
      }
    });
  });
}

function runGateway() {
  return new Promise((resolve) => {
    state.stage = "gateway";
    state.mode = "running";

    const args = [
      "dist/index.js",
      "gateway",
      "--bind",
      GATEWAY_BIND,
      "--port",
      String(GATEWAY_PORT),
      "--allow-unconfigured",
    ];

    logSupervisor(
      `Starting OpenClaw gateway: node ${args.join(" ")} (bind=${GATEWAY_BIND}, port=${GATEWAY_PORT})`
    );

    const child = spawn("node", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      gatewayLog.append(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      gatewayLog.append(chunk);
    });

    child.on("error", (err) => {
      logSupervisor(`Failed to spawn gateway: ${err.message}`);
      state.mode = "fallback";
      state.failureStage = "gateway";
      state.failureExitCode = 1;
      state.failureSignal = null;
      resolve(false);
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        logSupervisor("Gateway exited normally with code 0.");
        // Normal exit: we still treat this as failure from the perspective of
        // long-running service, otherwise the pod would exit. Fall back to UI.
      } else {
        logSupervisor(
          `Gateway exited with code=${code} signal=${signal || "null"}`
        );
      }
      state.mode = "fallback";
      state.failureStage = "gateway";
      state.failureExitCode = code;
      state.failureSignal = signal;
      resolve(false);
    });
  });
}

function htmlEscape(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderFallbackPage() {
  const failureStage = state.failureStage || "unknown";
  const exitCode =
    state.failureExitCode === null ? "unknown" : String(state.failureExitCode);
  const signal = state.failureSignal || "none";

  const doctorText = doctorLog.toString() || "(no doctor output captured)";
  const gatewayText = gatewayLog.toString() || "(no gateway output captured)";

  const combinedLogs = `[doctor]\n${doctorText}\n\n[gateway]\n${gatewayText}`;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>OpenClaw - Safe Mode</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root {
        color-scheme: dark light;
        --bg: #0b1020;
        --card-bg: #111827;
        --border: #1f2937;
        --text: #e5e7eb;
        --muted: #9ca3af;
        --accent: #3b82f6;
        --accent-soft: rgba(59, 130, 246, 0.12);
        --danger: #f97373;
        --danger-soft: rgba(248, 113, 113, 0.12);
        --mono-bg: #020617;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text",
          sans-serif;
        background: radial-gradient(circle at top, #1f2937 0, #020617 55%);
        color: var(--text);
        min-height: 100vh;
        display: flex;
        align-items: stretch;
        justify-content: center;
        padding: 32px 16px;
      }
      .shell {
        max-width: 1120px;
        width: 100%;
        margin: auto;
      }
      .card {
        background: linear-gradient(
            to bottom right,
            rgba(59, 130, 246, 0.08),
            rgba(15, 23, 42, 0.95)
          ),
          var(--card-bg);
        border-radius: 18px;
        border: 1px solid rgba(148, 163, 184, 0.2);
        padding: 20px 22px;
        box-shadow: 0 22px 60px rgba(15, 23, 42, 0.8);
        backdrop-filter: blur(16px);
        display: grid;
        grid-template-columns: minmax(0, 1.4fr) minmax(0, 1.1fr);
        gap: 18px;
      }
      @media (max-width: 900px) {
        .card {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      .headline-row {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 10px;
      }
      .status-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border-radius: 999px;
        padding: 4px 10px;
        font-size: 11px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        border: 1px solid rgba(248, 113, 113, 0.5);
        background: linear-gradient(
          to right,
          var(--danger-soft),
          rgba(15, 23, 42, 0.96)
        );
      }
      .status-dot {
        width: 7px;
        height: 7px;
        border-radius: 999px;
        background: var(--danger);
        box-shadow: 0 0 14px rgba(248, 113, 113, 0.8);
      }
      h1 {
        font-size: 22px;
        margin: 0;
        font-weight: 600;
        letter-spacing: -0.02em;
      }
      .subtext {
        font-size: 13px;
        color: var(--muted);
        margin-top: 6px;
        line-height: 1.5;
      }
      .meta-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 14px;
      }
      .meta-pill {
        border-radius: 999px;
        border: 1px solid rgba(148, 163, 184, 0.4);
        padding: 4px 9px;
        font-size: 11px;
        color: var(--muted);
        display: inline-flex;
        gap: 6px;
        align-items: center;
      }
      .meta-label {
        opacity: 0.7;
      }
      .meta-value {
        color: var(--text);
      }
      .actions {
        margin-top: 16px;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }
      .btn {
        border-radius: 999px;
        padding: 7px 14px;
        font-size: 13px;
        border: none;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-weight: 500;
      }
      .btn-primary {
        background: linear-gradient(
          135deg,
          var(--accent),
          rgba(59, 130, 246, 0.7)
        );
        color: white;
        box-shadow: 0 12px 30px rgba(37, 99, 235, 0.55);
      }
      .btn-secondary {
        background: rgba(15, 23, 42, 0.9);
        color: var(--muted);
        border: 1px solid rgba(148, 163, 184, 0.5);
      }
      .btn[disabled] {
        opacity: 0.7;
        cursor: default;
        box-shadow: none;
      }
      .hint-text {
        font-size: 11px;
        color: var(--muted);
        margin-top: 3px;
      }
      .logs-card {
        border-radius: 14px;
        background: radial-gradient(
            circle at top,
            rgba(15, 23, 42, 0.9),
            var(--mono-bg)
          ),
          var(--mono-bg);
        border: 1px solid rgba(55, 65, 81, 0.85);
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        min-height: 220px;
        max-height: 420px;
      }
      .logs-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
      }
      .logs-title {
        font-size: 13px;
        font-weight: 500;
      }
      .logs-subtitle {
        font-size: 11px;
        color: var(--muted);
      }
      .log-badges {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .log-badge {
        border-radius: 999px;
        border: 1px solid rgba(55, 65, 81, 0.9);
        padding: 2px 7px;
        font-size: 10px;
        color: var(--muted);
      }
      .log-area {
        margin-top: 8px;
        flex: 1;
        border-radius: 10px;
        background: radial-gradient(
            circle at top left,
            rgba(37, 99, 235, 0.12),
            transparent 55%
          ),
          #020617;
        padding: 8px 10px;
        overflow: auto;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
          "Liberation Mono", "Courier New", monospace;
        font-size: 11px;
        line-height: 1.4;
        color: #d1d5db;
        border: 1px solid rgba(31, 41, 55, 0.8);
      }
      .log-area pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .footer-hint {
        margin-top: 10px;
        font-size: 11px;
        color: var(--muted);
        display: flex;
        justify-content: space-between;
        gap: 8px;
        flex-wrap: wrap;
      }
      .footer-hint a {
        color: var(--accent);
        text-decoration: none;
      }
      .footer-hint a:hover {
        text-decoration: underline;
      }
      .pill-success {
        background: var(--accent-soft);
        border-color: rgba(59, 130, 246, 0.8);
        color: var(--accent);
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="card">
        <div>
          <div class="headline-row">
            <div class="status-pill">
              <span class="status-dot"></span>
              <span>Safe mode</span>
            </div>
            <h1>OpenClaw failed to start</h1>
          </div>
          <p class="subtext">
            The OpenClaw gateway did not come up successfully. You can review the
            startup logs below and use the web terminal or Filebrowser in this
            pod to fix configuration issues, then restart the pod.
          </p>
          <div class="meta-row">
            <div class="meta-pill">
              <span class="meta-label">Failure stage</span>
              <span class="meta-value">${htmlEscape(failureStage)}</span>
            </div>
            <div class="meta-pill">
              <span class="meta-label">Exit code</span>
              <span class="meta-value">${htmlEscape(exitCode)}</span>
            </div>
            <div class="meta-pill">
              <span class="meta-label">Signal</span>
              <span class="meta-value">${htmlEscape(signal)}</span>
            </div>
          </div>
          <h4>Tools</h4>
          <div class="actions">
            <a class="btn btn-secondary" href="/workspace" target="_blank" rel="noreferrer">
              <span>Open Filebrowser</span>
            </a>
            <a class="btn btn-secondary" href="/tty" target="_blank" rel="noreferrer">
              <span>Open terminal</span>
            </a>
          </div>
          <h4>Actions</h4>
          <div class="actions">
            <button class="btn btn-primary" id="restartBtn">
              <span>Restart pod</span>
            </button>
            <button class="btn btn-secondary" id="copyBtn">
              <span>Copy logs</span>
            </button>
          </div>
        </div>
        <div class="logs-card">
          <div class="logs-header">
            <div>
              <div class="logs-title">Recent startup logs</div>
              <div class="logs-subtitle">
                Combined output from <code>doctor</code> and
                <code>gateway</code>
              </div>
            </div>
            <div class="log-badges">
              <span class="log-badge">doctor</span>
              <span class="log-badge">gateway</span>
            </div>
          </div>
          <div class="log-area" id="logArea">
            <pre>${htmlEscape(combinedLogs)}</pre>
          </div>
          <div class="footer-hint">
            <span>
              After fixing the issue, click <strong>Restart pod</strong> to
              trigger a fresh startup.
            </span>
          </div>
        </div>
      </div>
    </div>
    <script>
      const restartBtn = document.getElementById("restartBtn");
      const copyBtn = document.getElementById("copyBtn");
      const logArea = document.getElementById("logArea");

      if (restartBtn) {
        restartBtn.addEventListener("click", async () => {
          restartBtn.disabled = true;
          restartBtn.textContent = "Requesting restart...";
          try {
            const res = await fetch("/restart", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
            });
            if (res.ok) {
              restartBtn.textContent = "Restart requested";
            } else {
              restartBtn.disabled = false;
              restartBtn.textContent = "Restart pod";
              alert("Failed to request restart (HTTP " + res.status + ").");
            }
          } catch (err) {
            restartBtn.disabled = false;
            restartBtn.textContent = "Restart pod";
            alert("Failed to request restart: " + err);
          }
        });
      }

      if (copyBtn && logArea) {
        copyBtn.addEventListener("click", async () => {
          const text = logArea.innerText || logArea.textContent || "";
          try {
            await navigator.clipboard.writeText(text);
            copyBtn.textContent = "Copied";
            copyBtn.classList.add("pill-success");
            setTimeout(() => {
              copyBtn.textContent = "Copy logs";
              copyBtn.classList.remove("pill-success");
            }, 2200);
          } catch (err) {
            alert("Failed to copy logs: " + err);
          }
        });
      }
    </script>
  </body>
</html>`;
}

function startFallbackServer() {
  if (state.mode !== "fallback") {
    state.mode = "fallback";
  }

  logSupervisor(
    `Starting fallback HTTP server on port ${GATEWAY_PORT} (safe mode).`
  );

  const server = http.createServer((req, res) => {
    const { method, url } = req;

    if (url === "/healthz") {
      const body = JSON.stringify({
        status: state.mode,
        failureStage: state.failureStage,
      });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    if (url === "/restart" && method === "POST") {
      const body = JSON.stringify({ ok: true, message: "Restarting pod..." });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body, () => {
        logSupervisor("Received /restart request, exiting with code 1.");
        // Give the response a moment to flush before exiting.
        setTimeout(() => {
          process.exit(1);
        }, 100);
      });
      return;
    }

    // Default: serve HTML page
    const html = renderFallbackPage();
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(html),
    });
    res.end(html);
  });

  server.on("error", (err) => {
    logSupervisor(`Fallback server error: ${err.message}`);
  });

  server.listen(GATEWAY_PORT, "0.0.0.0", () => {
    logSupervisor(`Fallback server listening on 0.0.0.0:${GATEWAY_PORT}`);
  });
}

async function main() {
  try {
    const doctorOk = await runDoctor();
    if (!doctorOk) {
      startFallbackServer();
      return;
    }

    const gatewayOk = await runGateway();
    if (!gatewayOk) {
      startFallbackServer();
      return;
    }

    // If gateway ever exits cleanly, we still present fallback rather than
    // exiting PID 1 so that the pod remains reachable.
    startFallbackServer();
  } catch (err) {
    logSupervisor(`Unexpected error in supervisor: ${err && err.stack || err}`);
    state.mode = "fallback";
    state.failureStage = state.failureStage || "supervisor";
    state.failureExitCode = state.failureExitCode || 1;
    startFallbackServer();
  }
}

main();

