// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// The QuickJS eval adapter / runtime-eval provider caches are keyed on the
// compiler that compiled them. Before this fix the compiler part of the key was
// the hash of scripts/compiler-bundle.mjs — the constant "no-bundle" when no
// bundle exists — so a compiler (src/) change kept the key and a stale adapter
// was served as a cache HIT. Hermetic: temp directories only, no QuickJS build.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { computeCompilerInputsHash } from "../scripts/compiler-inputs-hash.mjs";
import { computeCompilerBundleHash, runtimeEvalProviderCacheKey } from "../scripts/runtime-eval-provider.mjs";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "adapter-key-"));
  roots.push(root);
  mkdirSync(join(root, "src", "codegen"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "codegen", "emit.ts"), "export const b = 2;\n");
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(root, "docs", "notes.md"), "unrelated\n");
  return root;
}

const key = (root: string, extra: { bundlePaths?: string[]; useGit?: boolean } = {}) =>
  computeCompilerInputsHash({ root, useGit: false, memoize: false, ...extra });

function gitInit(root: string): void {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
  const run = (...args: string[]) => execFileSync("git", args, { cwd: root, env, stdio: "ignore" });
  run("init", "-q");
  run("add", "-A");
  run("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("QuickJS adapter cache key covers compiler inputs", () => {
  it("is deterministic for identical inputs", () => {
    const a = makeRoot();
    const b = makeRoot();
    expect(key(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(key(a)).toBe(key(a));
    expect(key(a)).toBe(key(b));
  });

  it("changes when a compiler source file changes", () => {
    const root = makeRoot();
    const before = key(root);
    writeFileSync(join(root, "src", "codegen", "emit.ts"), "export const b = 3;\n");
    expect(key(root)).not.toBe(before);
  });

  it("changes when a compiler source file is added or renamed", () => {
    const root = makeRoot();
    const before = key(root);
    writeFileSync(join(root, "src", "codegen", "extra.ts"), "export {};\n");
    const added = key(root);
    expect(added).not.toBe(before);
    rmSync(join(root, "src", "codegen", "extra.ts"));
    writeFileSync(join(root, "src", "codegen", "renamed.ts"), "export {};\n");
    expect(key(root)).not.toBe(added);
  });

  it("changes when pnpm-lock.yaml or the compiler bundle changes", () => {
    const root = makeRoot();
    const bundle = join(root, "compiler-bundle.mjs");
    const noBundle = key(root, { bundlePaths: [bundle] });
    writeFileSync(bundle, "export function compile() {}\n");
    const withBundle = key(root, { bundlePaths: [bundle] });
    expect(withBundle).not.toBe(noBundle);
    writeFileSync(bundle, "export function compile() { return 1; }\n");
    expect(key(root, { bundlePaths: [bundle] })).not.toBe(withBundle);
    const beforeLock = key(root);
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.1'\n");
    expect(key(root)).not.toBe(beforeLock);
  });

  it("ignores files outside the compiler inputs", () => {
    const root = makeRoot();
    const before = key(root);
    writeFileSync(join(root, "docs", "notes.md"), "edited\n");
    writeFileSync(join(root, "README.md"), "new\n");
    expect(key(root)).toBe(before);
  });

  it("git mode: clean tree uses the committed tree id; an edit or untracked file changes the key", () => {
    const root = makeRoot();
    gitInit(root);
    const clean = key(root, { useGit: true });
    expect(key(root, { useGit: true })).toBe(clean);
    writeFileSync(join(root, "docs", "notes.md"), "edited\n");
    expect(key(root, { useGit: true })).toBe(clean);
    writeFileSync(join(root, "src", "index.ts"), "export const a = 2;\n");
    const dirty = key(root, { useGit: true });
    expect(dirty).not.toBe(clean);
    writeFileSync(join(root, "src", "index.ts"), "export const a = 1;\n");
    expect(key(root, { useGit: true })).toBe(clean);
    writeFileSync(join(root, "src", "untracked.ts"), "export {};\n");
    expect(key(root, { useGit: true })).not.toBe(clean);
  });

  it("the provider cache key used by builder and readers folds the compiler hash in", () => {
    const hash = computeCompilerBundleHash();
    expect(hash).not.toBe("no-bundle");
    const source = "export const adapter = 1;";
    expect(runtimeEvalProviderCacheKey(source, hash)).toBe(runtimeEvalProviderCacheKey(source, hash));
    expect(runtimeEvalProviderCacheKey(source, hash)).not.toBe(runtimeEvalProviderCacheKey(source, `${hash}x`));
  });
});
