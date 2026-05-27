#!/usr/bin/env node

import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import os from "node:os";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PUBLIC_DIR = resolve(ROOT, "website", "public");
const PLAYGROUND_RESULTS_PATH = resolve(ROOT, "benchmarks", "results", "playground-benchmark-sidebar.json");
const PLAYGROUND_PUBLIC_PATH = resolve(
  ROOT,
  "website",
  "public",
  "benchmarks",
  "results",
  "playground-benchmark-sidebar.json",
);
const PLAYGROUND_PLAYGROUND_PUBLIC_PATH = resolve(
  ROOT,
  "website",
  "playground",
  "public",
  "benchmarks",
  "results",
  "playground-benchmark-sidebar.json",
);
const BROWSER_RESULTS_PATH = resolve(ROOT, "benchmarks", "results", "browser-runtime-benchmarks.json");
const BROWSER_PUBLIC_PATH = resolve(
  ROOT,
  "website",
  "public",
  "benchmarks",
  "results",
  "browser-runtime-benchmarks.json",
);

const HOST = "127.0.0.1";
const PORT = 4174;
const PAGE_PATH = "/benchmarks/runtime-benchmark.html";
const RESULT_ID = "result";
// #1392 — bounded timeout for the Playwright `eval` step so the whole
// `pnpm run refresh:benchmarks` pipeline can no longer hang indefinitely
// when a browser-side benchmark promise fails to settle. Override via the
// `BROWSER_EVAL_TIMEOUT_MS` env var when iterating on slow benchmarks.
const DEFAULT_EVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const BROWSER_EVAL_TIMEOUT_MS = (() => {
  const raw = process.env.BROWSER_EVAL_TIMEOUT_MS;
  if (!raw) return DEFAULT_EVAL_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_EVAL_TIMEOUT_MS;
  return parsed;
})();
// Heartbeat interval so the operator can tell the script is alive while
// waiting on the browser-runtime stage.
const HEARTBEAT_MS = 30_000;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function ensureParent(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function copyFileTo(source, destination) {
  ensureParent(destination);
  copyFileSync(source, destination);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  ensureParent(path);
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function contentType(filePath) {
  return MIME_TYPES[extname(filePath)] || "application/octet-stream";
}

function createStaticServer(rootDir) {
  return createServer((req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
      const pathname = decodeURIComponent(url.pathname === "/" ? PAGE_PATH : url.pathname);
      const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
      const filePath = resolve(rootDir, `.${safePath}`);
      if (!filePath.startsWith(rootDir) || !existsSync(filePath) || !statSync(filePath).isFile()) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "content-type": contentType(filePath), "cache-control": "no-store" });
      res.end(readFileSync(filePath));
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(String(error));
    }
  });
}

function playwrightWrapperPath() {
  const codexHome = process.env.CODEX_HOME || resolve(os.homedir(), ".codex");
  return join(codexHome, "skills", "playwright", "scripts", "playwright_cli.sh");
}

function runPlaywrightCommand(args, options = {}) {
  const pwcli = playwrightWrapperPath();
  return execFileSync(pwcli, args, {
    cwd: ROOT,
    env: { ...process.env, CODEX_HOME: process.env.CODEX_HOME || resolve(os.homedir(), ".codex") },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // `execFileSync` kills the child with SIGTERM when the timeout fires
    // and then throws an Error with `.signal === "SIGTERM"`. Callers that
    // need to differentiate "hang" from "command failed" inspect that
    // property on the rethrown error.
    timeout: options.timeoutMs,
  });
}

/** Fetch the per-benchmark progress trace from the live Playwright page. The
 *  page-side helper is installed by `public/benchmarks/runtime-benchmark.js`
 *  (see #1392). Returns `null` if the helper isn't available or the eval
 *  itself times out — we never want diagnostics to mask the real error. */
function fetchProgressDiagnostics() {
  try {
    const raw = runPlaywrightCommand(
      [
        "eval",
        "(window.__ts2wasmPollBrowserRuntimeBenchmarks ? window.__ts2wasmPollBrowserRuntimeBenchmarks() : null)",
      ],
      // Short timeout: if even this read hangs, the browser is wedged
      // and we'd rather propagate the original timeout error than block
      // the operator further. The page-side helper is a trivial
      // `JSON.stringify` so it should complete in milliseconds.
      { timeoutMs: 5_000 },
    );
    return extractJson(raw);
  } catch {
    return null;
  }
}

/** Identify the most likely "stuck" benchmark from the progress trace: the
 *  most recent `start` event without a matching `done`/`error`. Returns a
 *  short label suitable for inclusion in an error message. */
function summarizeStuck(progress) {
  if (!Array.isArray(progress) || progress.length === 0) {
    return "no progress events recorded — benchmarks may not have started";
  }
  const open = new Map();
  for (const event of progress) {
    if (!event || typeof event.name !== "string") continue;
    if (event.type === "start") open.set(event.name, event);
    else if (event.type === "done" || event.type === "error") open.delete(event.name);
  }
  if (open.size === 0) {
    const last = progress[progress.length - 1];
    return `last event: ${last.type} ${last.name ?? ""}`;
  }
  const stuckNames = [...open.keys()].join(", ");
  return `stuck on: ${stuckNames}`;
}

/** Run a Playwright eval with a bounded timeout, logging a heartbeat at
 *  `HEARTBEAT_MS` intervals so a stuck stage is visible without polling.
 *  Returns the raw stdout on success; throws on timeout or non-zero exit. */
function runPlaywrightEvalWithHeartbeat(label, expr, timeoutMs) {
  const start = Date.now();
  let heartbeat;
  if (HEARTBEAT_MS > 0) {
    heartbeat = setInterval(() => {
      const elapsedSec = Math.round((Date.now() - start) / 1000);
      const limitSec = Math.round(timeoutMs / 1000);
      console.log(`[browser-runtime] still waiting on ${label}: ${elapsedSec}s / ${limitSec}s`);
    }, HEARTBEAT_MS);
    if (typeof heartbeat.unref === "function") heartbeat.unref();
  }
  try {
    return runPlaywrightCommand(["eval", expr], { timeoutMs });
  } catch (error) {
    // execFileSync surfaces timeouts as ETIMEDOUT (Node ≥18) or via the
    // `signal` field. Surface a clearer error so the operator sees that
    // it was a timeout, not a Playwright-internal error.
    const isTimeout =
      (error && (error.code === "ETIMEDOUT" || error.signal === "SIGTERM")) || Date.now() - start >= timeoutMs;
    if (isTimeout) {
      const elapsedSec = Math.round((Date.now() - start) / 1000);
      // The Playwright child has been killed but the browser session is
      // still alive on the wrapper side, so a follow-up `eval` can pull
      // the per-benchmark progress trace and identify the stuck entry.
      const diagnostics = fetchProgressDiagnostics();
      const stuckSummary = diagnostics ? summarizeStuck(diagnostics.progress) : "diagnostics unavailable";
      const wrapped = new Error(
        `Browser-runtime stage timed out after ${elapsedSec}s (limit ${Math.round(timeoutMs / 1000)}s) ` +
          `running ${label}. ${stuckSummary}. Set BROWSER_EVAL_TIMEOUT_MS to extend, or inspect the ` +
          `browser console at ${`http://${HOST}:${PORT}${PAGE_PATH}`} to identify the stuck benchmark.`,
      );
      wrapped.cause = error;
      wrapped.timeout = true;
      wrapped.diagnostics = diagnostics;
      throw wrapped;
    }
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

function extractJson(text) {
  const trimmed = text.trim();
  const candidates = [trimmed];
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    try {
      candidates.push(JSON.parse(trimmed));
    } catch {
      // Ignore.
    }
  }
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const match = candidate.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
    if (!match) continue;
    try {
      return JSON.parse(match[1]);
    } catch {
      // Ignore.
    }
  }
  throw new Error(`Unable to parse Playwright result JSON from output:\n${text}`);
}

function mergeRuntimeSnapshots(nodeRows, browserRows) {
  const browserPaths = new Set(browserRows.map((row) => row.path));
  return [...nodeRows.filter((row) => !browserPaths.has(row.path)), ...browserRows];
}

async function main() {
  if (!existsSync(PLAYGROUND_RESULTS_PATH)) {
    throw new Error(`Missing compute runtime snapshot: ${PLAYGROUND_RESULTS_PATH}`);
  }

  // Skip browser benchmarks if Playwright is not available (e.g. CI runners)
  const pwcli = playwrightWrapperPath();
  if (!existsSync(pwcli)) {
    console.log(`Playwright not found at ${pwcli} — skipping browser runtime benchmarks.`);
    console.log("Browser benchmarks only run locally (version tag pushes). CI uses Node.js benchmarks only.");
    return;
  }

  const server = createStaticServer(PUBLIC_DIR);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, resolve);
  });

  try {
    const pageUrl = `http://${HOST}:${PORT}${PAGE_PATH}`;
    console.log(`Opening ${pageUrl} in Playwright...`);
    // The `open` step itself is bounded so a stuck browser launch doesn't
    // wedge the pipeline either. Use a shorter limit since it's a fixed-cost
    // navigation, not a benchmark loop.
    runPlaywrightCommand(["open", pageUrl], { timeoutMs: 60_000 });

    console.log(`Running browser runtime benchmarks (timeout ${Math.round(BROWSER_EVAL_TIMEOUT_MS / 1000)}s)...`);
    const rawOutput = runPlaywrightEvalWithHeartbeat(
      "__ts2wasmRunBrowserRuntimeBenchmarks",
      `window.__ts2wasmRunBrowserRuntimeBenchmarks().then((rows) => { document.getElementById("${RESULT_ID}").textContent = JSON.stringify(rows); return document.getElementById("${RESULT_ID}").textContent; })`,
      BROWSER_EVAL_TIMEOUT_MS,
    );
    // Parse BEFORE writing anything so a malformed result doesn't truncate
    // the committed JSON. If `extractJson` throws, the catch block in
    // `main().catch(...)` will surface it and the on-disk artifacts stay
    // unchanged (acceptance criterion #5).
    const browserRows = extractJson(rawOutput);
    writeJson(BROWSER_RESULTS_PATH, browserRows);
    copyFileTo(BROWSER_RESULTS_PATH, BROWSER_PUBLIC_PATH);

    const computeRows = readJson(PLAYGROUND_RESULTS_PATH);
    const mergedRows = mergeRuntimeSnapshots(computeRows, browserRows);
    writeJson(PLAYGROUND_RESULTS_PATH, mergedRows);
    copyFileTo(PLAYGROUND_RESULTS_PATH, PLAYGROUND_PUBLIC_PATH);
    copyFileTo(PLAYGROUND_RESULTS_PATH, PLAYGROUND_PLAYGROUND_PUBLIC_PATH);

    console.log(`Wrote ${BROWSER_RESULTS_PATH}`);
    console.log(`Updated ${PLAYGROUND_RESULTS_PATH}`);
  } finally {
    // `server.close()` waits for in-flight requests to finish; combined
    // with the bounded eval timeout this is now guaranteed to exit.
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  // Distinguish timeout from other failures so log scrapers / CI badges
  // can react to "stuck-benchmark" rollups separately.
  if (error && error.timeout) {
    console.error(`[browser-runtime] TIMEOUT: ${error.message}`);
    if (error.diagnostics) {
      console.error("[browser-runtime] page diagnostics at timeout:");
      console.error(JSON.stringify(error.diagnostics, null, 2));
    }
  } else {
    console.error(error);
  }
  // Acceptance criterion #5: a timeout must never leave a partially written
  // `browser-runtime-benchmarks.json` behind. `writeJson(BROWSER_RESULTS_PATH, ...)`
  // is only called inside `main()` AFTER `extractJson(rawOutput)` succeeds,
  // so a timeout (which throws before that line) leaves the existing
  // on-disk artifact untouched. Nothing to clean up here.
  process.exitCode = 1;
});
