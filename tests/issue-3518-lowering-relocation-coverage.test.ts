// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LOWERING_TARGETS } from "../scripts/check-pushraw.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checker = resolve(repository, "scripts/check-pushraw.mjs");
const legacy = "src/ir/lower.ts";
const generic = "src/ir/lower-generic.ts";
const baselinePath = "scripts/pushraw-baseline.json";
const expectedTargets = [
  legacy,
  generic,
  "src/ir/backend/lower-contracts.ts",
  "src/ir/backend/wasm-constants.ts",
  "src/ir/backend/wasm-lowering.ts",
];
const roots: string[] = [];
const oldSource = `export function lower(emitter, out) {
  emitter.pushRaw(out, legacy);
  // pushraw-ok(#2953): retained reviewed escape
  emitter.pushRaw(out, reviewed);
}
`;

function cleanEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_") || key === "LOC_GATE_BASE") Reflect.deleteProperty(env, key);
  }
  return env;
}

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "js2-lowering-ratchet-"));
  roots.push(root);
  const put = (path: string, source: string) => {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), source);
  };
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: cleanEnvironment() });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git("init", "-q");
  git("config", "user.name", "Thomas Tränkler");
  git("config", "user.email", "git@thomas.traenkler.com");
  put(legacy, oldSource);
  git("add", "--", legacy);
  git("commit", "-qm", "test(ir): seed isolated relocation fixture\n\nCo-authored-by: Codex <codex@openai.com>");
  const base = git("rev-parse", "HEAD");
  for (const path of expectedTargets) put(path, "export {};\n");
  put(legacy, 'export { lower } from "./lower-generic.js";\n');
  put(generic, `// Relocated implementation; no inherited site may disappear.\n${oldSource}`);
  put(baselinePath, readFileSync(resolve(repository, baselinePath), "utf8"));
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [checker, "--root", root, ...args], {
      encoding: "utf8",
      env: { ...cleanEnvironment(), LOC_GATE_BASE: base },
      timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return { exit: result.status, output: result.stdout + result.stderr };
  };
  return { root, put, run, git };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("#3518 lowering relocation keeps the real pushRaw gate connected", () => {
  it("requires all five fixed paths independently of the baseline", () => {
    expect(LOWERING_TARGETS).toEqual(expectedTargets);
    const baseline = JSON.parse(readFileSync(resolve(repository, baselinePath), "utf8"));
    expect(baseline).toMatchObject({
      path: generic,
      paths: expectedTargets,
      relocatedFrom: legacy,
    });
    expect(baseline.untagged).toBeGreaterThanOrEqual(0);
    expect(baseline.untagged).toBeLessThanOrEqual(82);
    expect(baseline.total).toBe(baseline.tagged + baseline.untagged);
  });

  it("accepts the actual old-to-new source diff with both original sites and tags", () => {
    const f = fixture();
    const report = f.run("--json");
    expect(report.exit).toBe(0);
    expect(JSON.parse(report.output)).toMatchObject({ total: 2, tagged: 1, untagged: 1, paths: expectedTargets });
    expect(f.run()).toMatchObject({ exit: 0 });
    expect(f.run().output).toContain("0 added");
  });

  it.each(expectedTargets)("rejects a new untagged escape in %s, including untracked files", (path) => {
    const f = fixture();
    f.put(path, readFileSync(resolve(f.root, path), "utf8") + "emitter.pushRaw(out, injected);\n");
    const result = f.run();
    expect(result.exit).toBe(1);
    expect(result.output).toContain(path);
    expect(result.output).toContain("injected");
  });

  it("rejects replacing a moved legacy site without changing the denominator", () => {
    const f = fixture();
    f.put(generic, oldSource.replace("out, legacy", "out, replacement"));
    expect(f.run()).toMatchObject({ exit: 1 });
  });

  it("does not grant duplicate legacy site credit to the facade", () => {
    const f = fixture();
    f.put(legacy, oldSource);
    expect(f.run()).toMatchObject({ exit: 1 });
  });

  it("still admits newly reviewed tagged sites", () => {
    const f = fixture();
    f.put(
      generic,
      oldSource + "// pushraw-ok(#3518): fixture-only reviewed addition\nemitter.pushRaw(out, reviewedNew);\n",
    );
    expect(f.run()).toMatchObject({ exit: 0 });
  });

  it("compares the canonical path with itself after the relocation has landed", () => {
    const f = fixture();
    f.git("add", "--", "src", baselinePath);
    f.git("commit", "-qm", "test(ir): record fixture relocation\n\nCo-authored-by: Codex <codex@openai.com>");
    const result = spawnSync(process.execPath, [checker, "--root", f.root], {
      encoding: "utf8",
      env: { ...cleanEnvironment(), LOC_GATE_BASE: f.git("rev-parse", "HEAD") },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("0 added");
  });

  for (const mode of [[], ["--all"], ["--json"]]) {
    it.each(expectedTargets)(`fails closed for a missing %s (${mode.join(" ") || "change-scoped"})`, (path) => {
      const f = fixture();
      rmSync(resolve(f.root, path));
      expect(f.run(...mode).exit).not.toBe(0);
    });
  }

  it("rejects a baseline that drops a tracked lowering path", () => {
    const f = fixture();
    const baseline = JSON.parse(readFileSync(resolve(f.root, baselinePath), "utf8"));
    baseline.paths.pop();
    f.put(baselinePath, JSON.stringify(baseline));
    expect(f.run("--all")).toMatchObject({ exit: 1 });
  });
});
