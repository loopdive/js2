#!/usr/bin/env node

import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const WEBSITE_ROOT = resolve(ROOT, "website");
const PUBLIC_DIR = resolve(WEBSITE_ROOT, "public");
const PLAYGROUND_RESULTS_PATH = resolve(ROOT, "benchmarks", "results", "playground-benchmark-sidebar.json");
const PLAYGROUND_PUBLIC_PATH = resolve(WEBSITE_ROOT, "public", "benchmarks", "results", "playground-benchmark-sidebar.json");
const PLAYGROUND_PLAYGROUND_PUBLIC_PATH = resolve(
  WEBSITE_ROOT,
  "playground",
  "public",
  "benchmarks",
  "results",
  "playground-benchmark-sidebar.json",
);
const BROWSER_RESULTS_PATH = resolve(ROOT, "benchmarks", "results", "browser-runtime-benchmarks.json");
const BROWSER_PUBLIC_PATH = resolve(WEBSITE_ROOT, "public", "benchmarks", "results", "browser-runtime-benchmarks.json");

const HOST = "127.0.0.1";
const PORT = 4174;
const PAGE_PATH = "/benchmarks/runtime-benchmark.html";
const PLAYWRIGHT_TIMEOUT_MS = 120_000;

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

function mergeRuntimeSnapshots(nodeRows, browserRows) {
  const browserPaths = new Set(browserRows.map((row) => row.path));
  return [...nodeRows.filter((row) => !browserPaths.has(row.path)), ...browserRows];
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (error) {
    console.log("Playwright is not installed — skipping browser runtime benchmarks.");
    console.log(error?.message || error);
    return null;
  }
}

async function runBenchmarksInPlaywright(pageUrl) {
  const playwright = await loadPlaywright();
  if (!playwright) return null;

  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
  } catch (error) {
    console.log("Playwright Chromium is unavailable — skipping browser runtime benchmarks.");
    console.log(error?.message || error);
    return null;
  }

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(PLAYWRIGHT_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(PLAYWRIGHT_TIMEOUT_MS);
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        console.log(`[browser:${message.type()}] ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => {
      console.log(`[browser:error] ${error.message}`);
    });

    await page.goto(pageUrl, { waitUntil: "load" });
    await page.waitForFunction(() => typeof window.__ts2wasmRunBrowserRuntimeBenchmarks === "function");

    return await page.evaluate(() =>
      window.__ts2wasmRunBrowserRuntimeBenchmarks({
        includeRuntimeEnvironments: ["node", "browser"],
        skipMissingExports: true,
      }),
    );
  } finally {
    await browser.close();
  }
}

async function main() {
  if (!existsSync(PLAYGROUND_RESULTS_PATH)) {
    throw new Error(`Missing compute runtime snapshot: ${PLAYGROUND_RESULTS_PATH}`);
  }

  const server = createStaticServer(PUBLIC_DIR);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, resolve);
  });

  try {
    const pageUrl = `http://${HOST}:${PORT}${PAGE_PATH}`;
    console.log(`Running JS host benchmarks in Playwright at ${pageUrl}...`);
    const browserRows = await runBenchmarksInPlaywright(pageUrl);
    if (!Array.isArray(browserRows) || browserRows.length === 0) {
      console.log("No Playwright browser runtime benchmarks completed.");
      return;
    }

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
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
