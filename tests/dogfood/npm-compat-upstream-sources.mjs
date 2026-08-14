import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { inventoryDigest } from "./setup-pinned-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = join(HERE, ".npm-upstream-suites");
const PINS = JSON.parse(readFileSync(new URL("./npm-compat-upstream-sources.json", import.meta.url), "utf-8"));
const BY_NAME = new Map(PINS.map((pin) => [pin.name, Object.freeze(pin)]));

if (BY_NAME.size !== PINS.length) throw new Error("[dogfood] duplicate npm-compat upstream source pin");

export const NPM_COMPAT_UPSTREAM_SOURCES = Object.freeze([...BY_NAME.values()]);
export const NPM_COMPAT_UPSTREAM_NAMES = Object.freeze(PINS.map((pin) => pin.name));

function checkoutCommit(root) {
  if (!existsSync(join(root, ".git"))) return null;
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function walk(root, directory, accept, out = []) {
  const absolute = join(root, directory);
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const path = join(directory, entry.name).replace(/\\/g, "/");
    if (entry.isDirectory()) walk(root, path, accept, out);
    else if (entry.isFile() && accept(path)) out.push(path);
  }
  return out;
}

export function npmCompatUpstreamSource(name) {
  const pin = BY_NAME.get(name);
  if (!pin) {
    throw new Error(
      `[dogfood] unknown npm-compat upstream package ${name}; expected ${NPM_COMPAT_UPSTREAM_NAMES.join(", ")}`,
    );
  }
  return pin;
}

export function setupNpmCompatUpstreamSource(name, { force = false } = {}) {
  const pin = npmCompatUpstreamSource(name);
  const root = join(SOURCE_ROOT, pin.cacheKey ?? pin.name);

  if (force && existsSync(root)) rmSync(root, { recursive: true, force: true });
  if (checkoutCommit(root) === null) {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    mkdirSync(dirname(root), { recursive: true });
    execFileSync("git", ["clone", "--depth", "1", "--branch", pin.tag, pin.repo, root], { stdio: "inherit" });
  }

  const commit = checkoutCommit(root);
  if (commit !== pin.commit) {
    throw new Error(
      `[dogfood] ${name} source checkout integrity mismatch\n` +
        `  expected ${pin.commit} (${pin.tag})\n` +
        `  got      ${commit ?? "no commit"}`,
    );
  }

  let testFiles = null;
  if (pin.inventory) {
    const include = new RegExp(pin.inventory.include);
    testFiles = walk(root, pin.inventory.directory, (path) => include.test(path)).sort();
    const digest = inventoryDigest(testFiles);
    if (testFiles.length !== pin.inventory.fileCount || digest !== pin.inventory.pathSha256) {
      throw new Error(
        `[dogfood] ${name} upstream unit inventory mismatch\n` +
          `  expected ${pin.inventory.fileCount} files / ${pin.inventory.pathSha256}\n` +
          `  got      ${testFiles.length} files / ${digest}`,
      );
    }
  }

  return { root: resolve(root), pin, testFiles };
}

function parseCli(argv) {
  const names = [];
  let force = false;
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--all") names.push(...NPM_COMPAT_UPSTREAM_NAMES);
    else if (arg === "--force") force = true;
    else if (arg === "--json") json = true;
    else if (arg === "--package") names.push(argv[++index]);
    else if (arg.startsWith("--package=")) names.push(arg.slice("--package=".length));
    else throw new Error(`[dogfood] unknown argument ${arg}`);
  }
  if (names.length === 0) throw new Error("[dogfood] pass --package <name> or --all");
  return { names: [...new Set(names)], force, json };
}

function main() {
  const options = parseCli(process.argv.slice(2));
  const results = options.names.map((name) => {
    const setup = setupNpmCompatUpstreamSource(name, options);
    return {
      name,
      version: setup.pin.version,
      tag: setup.pin.tag,
      commit: setup.pin.commit,
      root: setup.root,
      testFiles: setup.testFiles?.length ?? null,
      suiteAdapter: setup.pin.suiteScript ?? null,
    };
  });
  if (options.json) process.stdout.write(`${JSON.stringify(results)}\n`);
  else {
    for (const result of results) {
      console.log(
        `[dogfood] ${result.name}@${result.version}: ${result.commit.slice(0, 12)}; ` +
          `${result.testFiles ?? "existing adapter"} unit files`,
      );
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
