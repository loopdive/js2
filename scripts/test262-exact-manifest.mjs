#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6712 — Read a deliberately exact Test262 selection without relying on the
 * runner's category walk.  This is intentionally independent of Vitest and
 * the compiler so the shell wrapper can reject a bad manifest before a costly
 * build starts.
 *
 * Manifest identities are canonical corpus-relative `test/...` POSIX paths,
 * one per line.  They are not a convenience filter: each line is an original
 * file that must exist beneath the pinned Test262 corpus's real test root.
 */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

export class Test262ExactManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = "Test262ExactManifestError";
  }
}

function fail(manifestPath, message) {
  throw new Test262ExactManifestError(`Test262 exact manifest ${manifestPath}: ${message}`);
}

/** Hash exact manifest bytes so a runner can prove its snapshot stayed fixed. */
export function sha256Test262ExactManifestFile(manifestPath) {
  try {
    if (!statSync(manifestPath).isFile()) fail(manifestPath, "input is not a regular file");
    return createHash("sha256").update(readFileSync(manifestPath)).digest("hex");
  } catch (error) {
    if (error instanceof Test262ExactManifestError) throw error;
    fail(manifestPath, `cannot read input: ${error.message}`);
  }
}

/**
 * Parse canonical `test/...` identities.  A final newline is the normal
 * representation and is deliberately discarded only once; interior blank
 * lines remain invalid entries rather than being silently filtered away.
 */
export function parseTest262ExactManifest(text, manifestPath = "<manifest>") {
  if (typeof text !== "string" || text.length === 0) {
    fail(manifestPath, "must contain at least one path");
  }

  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  if (lines.length === 0) fail(manifestPath, "must contain at least one path");

  const seen = new Set();
  const paths = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const number = index + 1;
    if (line.length === 0) fail(manifestPath, `line ${number} is empty`);
    if (line !== line.trim() || /\s/.test(line)) {
      fail(manifestPath, `line ${number} contains whitespace`);
    }
    if (line.includes("\\")) fail(manifestPath, `line ${number} must use POSIX separators`);
    if (!line.startsWith("test/")) fail(manifestPath, `line ${number} must start with test/`);
    if (!line.endsWith(".js")) fail(manifestPath, `line ${number} is not a JavaScript test`);
    if (line.includes("_FIXTURE") || line.endsWith(".imports.js")) {
      fail(manifestPath, `line ${number} names a fixture-only helper`);
    }

    const segments = line.split("/");
    if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
      fail(manifestPath, `line ${number} is not a canonical corpus-relative path`);
    }
    if (seen.has(line)) fail(manifestPath, `line ${number} duplicates ${line}`);
    seen.add(line);
    paths.push(line);
  }
  return paths;
}

function realDirectory(path, label, manifestPath) {
  let realPath;
  try {
    realPath = realpathSync(path);
  } catch (error) {
    fail(manifestPath, `cannot resolve ${label} ${path}: ${error.message}`);
  }
  try {
    if (!statSync(realPath).isDirectory()) fail(manifestPath, `${label} is not a directory: ${path}`);
  } catch (error) {
    if (error instanceof Test262ExactManifestError) throw error;
    fail(manifestPath, `cannot inspect ${label} ${path}: ${error.message}`);
  }
  return realPath;
}

function assertContained(realTestRoot, realFile, manifestPath, line, identity) {
  const inside = relative(realTestRoot, realFile);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    fail(manifestPath, `line ${line} escapes the Test262 test root: ${identity}`);
  }
}

/**
 * Resolve every canonical identity to an existing regular file.  Both the
 * corpus root and candidate file are realpathed before containment is checked:
 * this keeps a symlinked corpus root valid while refusing a symlinked test file
 * that points outside it.
 */
export function readTest262ExactManifest(manifestPath, { test262Root } = {}) {
  if (typeof manifestPath !== "string" || manifestPath.length === 0) {
    fail("<manifest>", "input path is required");
  }
  if (typeof test262Root !== "string" || test262Root.length === 0) {
    fail(manifestPath, "Test262 corpus root is required");
  }

  let text;
  try {
    if (!statSync(manifestPath).isFile()) fail(manifestPath, "input is not a regular file");
    text = readFileSync(manifestPath, "utf8");
  } catch (error) {
    if (error instanceof Test262ExactManifestError) throw error;
    fail(manifestPath, `cannot read input: ${error.message}`);
  }

  const identities = parseTest262ExactManifest(text, manifestPath);
  const realCorpusRoot = realDirectory(test262Root, "Test262 corpus root", manifestPath);
  const realTestRoot = realDirectory(join(realCorpusRoot, "test"), "Test262 test root", manifestPath);

  return identities.map((relPath, index) => {
    const line = index + 1;
    const candidate = join(realTestRoot, ...relPath.split("/").slice(1));
    let realFile;
    try {
      realFile = realpathSync(candidate);
    } catch (error) {
      fail(manifestPath, `line ${line} does not resolve to an existing file: ${relPath} (${error.message})`);
    }
    assertContained(realTestRoot, realFile, manifestPath, line, relPath);
    try {
      if (!statSync(realFile).isFile()) fail(manifestPath, `line ${line} is not a regular file: ${relPath}`);
    } catch (error) {
      if (error instanceof Test262ExactManifestError) throw error;
      fail(manifestPath, `cannot inspect line ${line}: ${relPath} (${error.message})`);
    }
    return { filePath: realFile, relPath };
  });
}

function parseCliArguments(argv) {
  let input = "";
  let test262Root = "";
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--input") input = argv[++index] ?? "";
    else if (arg === "--test262-root") test262Root = argv[++index] ?? "";
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/test262-exact-manifest.mjs --input <manifest.txt> --test262-root <test262-root>",
      );
      return null;
    } else {
      throw new Test262ExactManifestError(`unknown argument: ${arg}`);
    }
  }
  if (!input) throw new Test262ExactManifestError("--input is required");
  if (!test262Root) throw new Test262ExactManifestError("--test262-root is required");
  return { input, test262Root };
}

function runCli(argv) {
  let options;
  try {
    options = parseCliArguments(argv);
    if (!options) return 0;
    const entries = readTest262ExactManifest(options.input, { test262Root: options.test262Root });
    console.log(`Validated ${entries.length} exact Test262 path(s) from ${options.input}`);
    return 0;
  } catch (error) {
    console.error(`ERROR: ${error.message ?? error}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
