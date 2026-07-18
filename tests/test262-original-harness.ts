// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface HarnessMeta {
  flags?: string[];
  includes?: string[];
}

export interface OriginalHarnessVariant {
  source: string;
  bodyLineOffset: number;
  strict: boolean;
}

export interface OriginalHarnessAssembly {
  primary: OriginalHarnessVariant;
  strictRerun?: OriginalHarnessVariant;
  async: boolean;
  raw: boolean;
}

const PROJECT_ROOT = join(import.meta.dirname ?? ".", "..");
const HARNESS_ROOT = join(PROJECT_ROOT, "test262", "harness");
const RUNTIME_PATH = join(PROJECT_ROOT, "scripts", "test262-fyi-runtime.js");
const sourceCache = new Map<string, string>();

function cachedSource(path: string): string {
  let source = sourceCache.get(path);
  if (source === undefined) {
    source = readFileSync(path, "utf8");
    sourceCache.set(path, source);
  }
  return source;
}

function harnessSource(name: string): string {
  return cachedSource(join(HARNESS_ROOT, name));
}

function lineCount(source: string): number {
  if (source.length === 0) return 0;
  return source.split("\n").length - 1;
}

function assembleVariant(
  source: string,
  meta: HarnessMeta,
  strict: boolean,
  raw: boolean,
  async: boolean,
): OriginalHarnessVariant {
  if (raw) return { source, bodyLineOffset: 0, strict };

  // Keep this order byte-for-byte equivalent to test262.fyi/data/runner/read.js:
  // strict directive, async helper, metadata includes, runtime shim, assert.js,
  // sta.js, and finally the untouched upstream test body.
  let prefix = strict ? '"use strict";\n' : "";
  if (async) prefix += harnessSource("doneprintHandle.js");
  for (const include of meta.includes ?? []) prefix += harnessSource(include);
  prefix += cachedSource(RUNTIME_PATH);
  prefix += harnessSource("assert.js");
  prefix += harnessSource("sta.js");
  return {
    source: prefix + source,
    bodyLineOffset: lineCount(prefix),
    strict,
  };
}

/**
 * Assemble exactly the source variants executed by test262.fyi's original
 * harness reader. The raw test body is never rewritten.
 */
export function assembleOriginalHarness(source: string, meta: HarnessMeta): OriginalHarnessAssembly {
  const flags = new Set(meta.flags ?? []);
  const raw = flags.has("raw");
  const async = flags.has("async");
  const onlyStrict = flags.has("onlyStrict");
  const strictRerun = !raw && !flags.has("module") && !onlyStrict && !flags.has("noStrict");

  return {
    primary: assembleVariant(source, meta, onlyStrict, raw, async),
    ...(strictRerun ? { strictRerun: assembleVariant(source, meta, true, raw, async) } : {}),
    async,
    raw,
  };
}
