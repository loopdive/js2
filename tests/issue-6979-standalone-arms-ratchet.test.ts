// #6979 S7-c — the `ctx.standalone` arm ratchet fails on growth, passes on
// shrink, banks only decreases, and does not count look-alike identifiers.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "scripts", "check-standalone-arms.mjs");

function tree(files: Record<string, string>): { root: string; baseline: string } {
  const root = mkdtempSync(join(tmpdir(), "standalone-arms-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return { root, baseline: join(root, "baseline.json") };
}

function run(t: { root: string; baseline: string }, ...flags: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("node", [SCRIPT, "--root", t.root, "--baseline", t.baseline, ...flags], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: err.stdout + err.stderr };
  }
}

describe("#6979 check-standalone-arms", () => {
  it("counts ctx.standalone per directory, not ctx.standaloneGlobalThisImport", () => {
    const t = tree({
      "src/a/x.ts": "if (ctx.standalone) {}\nconst y = this.ctx.standalone;\nctx.standaloneGlobalThisImport;\n",
      "src/b/y.ts": "ctx.wasi;\n",
    });
    expect(run(t, "--update").code).toBe(0);
    expect(JSON.parse(readFileSync(t.baseline, "utf8"))).toEqual({ "src/a": 2 });
  });

  it("fails on growth, including a new directory, and passes on shrink", () => {
    const t = tree({ "src/a/x.ts": "ctx.standalone; ctx.standalone;\n" });
    run(t, "--update");
    writeFileSync(join(t.root, "src/a/x.ts"), "ctx.standalone; ctx.standalone; ctx.standalone;\n");
    expect(run(t).code).toBe(1);
    writeFileSync(join(t.root, "src/a/x.ts"), "ctx.standalone;\n");
    mkdirSync(join(t.root, "src/c"));
    writeFileSync(join(t.root, "src/c/z.ts"), "ctx.standalone;\n");
    expect(run(t).code).toBe(1);
    writeFileSync(join(t.root, "src/c/z.ts"), "\n");
    expect(run(t).code).toBe(0);
  });

  it("--update-on-decrease lowers and never raises", () => {
    const t = tree({ "src/a/x.ts": "ctx.standalone; ctx.standalone;\n", "src/b/y.ts": "ctx.standalone;\n" });
    run(t, "--update");
    writeFileSync(join(t.root, "src/a/x.ts"), "ctx.standalone; ctx.standalone; ctx.standalone;\n");
    writeFileSync(join(t.root, "src/b/y.ts"), "\n");
    expect(run(t, "--update-on-decrease").code).toBe(0);
    expect(JSON.parse(readFileSync(t.baseline, "utf8"))).toEqual({ "src/a": 2 });
  });
});
