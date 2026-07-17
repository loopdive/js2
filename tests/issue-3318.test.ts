// (#3318) "Cannot create property 'declaredType' on number '1'" — an
// in-process realm-pollution crash, not a per-test compiler bug. The
// in-process runner (runTest262File) executes compiled test code in the
// caller's own realm; lastIndexOf/15.4.4.15-8-a-14.js leaves
// `Array.prototype[1] = 1` behind, and the NEXT compile crashes inside the
// TypeScript checker (its symbolLinks array read inherits the polluted
// index). Fix: restoreHostBuiltins() at runTest262File entry (the in-process
// counterpart of the sharded worker's restoreBuiltins, #1153..#1221).
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { runTest262File } from "./test262-runner.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { compile } from "../src/index.js";

const ROOT = "/workspace/test262/test/";
const CITED = [
  "built-ins/Array/prototype/indexOf/15.4.4.14-9-a-14.js",
  "built-ins/Array/prototype/lastIndexOf/15.4.4.15-8-a-14.js",
];

describe("#3318 prototype-pollution compile crash", () => {
  it("both cited files run back-to-back in-process without an internal crash", async () => {
    for (const rel of CITED) {
      if (!existsSync(ROOT + rel)) return; // test262 checkout not present
      const res = await runTest262File(ROOT + rel, rel.split("/")[0]!);
      expect(String(res.error ?? ""), `${rel} must not crash the compiler internally`).not.toMatch(
        /declaredType|Cannot create property/,
      );
      expect(res.status).toBe("pass");
    }
  });

  it("the same file twice in one process stays green (entry restore)", async () => {
    const rel = CITED[1]!;
    if (!existsSync(ROOT + rel)) return;
    const first = await runTest262File(ROOT + rel, rel.split("/")[0]!);
    const second = await runTest262File(ROOT + rel, rel.split("/")[0]!);
    expect(first.status).toBe("pass");
    expect(second.status).toBe("pass"); // was compile_error pre-fix
  });

  it("restoreHostBuiltins clears synthetic numeric Array.prototype pollution", async () => {
    (Array.prototype as unknown as Record<number, unknown>)[1] = 1;
    expect(Object.getOwnPropertyDescriptor(Array.prototype, "1")).toBeDefined();
    restoreHostBuiltins();
    expect(Object.getOwnPropertyDescriptor(Array.prototype, "1")).toBeUndefined();
    // And a compile after the restore works (a fresh checker initializes).
    const r = await compile("export function test(): number { return 1; }", { fileName: "t.ts" });
    expect(r.success).toBe(true);
  });

  it("restores a replaced builtin method value", () => {
    const orig = Array.prototype.includes;
    // eslint-disable-next-line no-extend-native
    (Array.prototype as unknown as Record<string, unknown>).includes = () => {
      throw new Error("poisoned");
    };
    restoreHostBuiltins();
    expect(Array.prototype.includes).toBe(orig);
  });
});
