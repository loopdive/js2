// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5383 S2n — the `$__vec_base` push/pop brand arm must not depend on the order
// of two finalize passes.
//
// Its own file rather than a block in `issue-5383-standalone-temporal-provider.test.ts`:
// that file already spends ~140 s, most of it in ONE child-process assertion
// that compiles the 3.3 MB Temporal provider, and adding these two compiles to
// it pushed the worker past vitest's `onTaskUpdate` RPC heartbeat — every test
// passed and the FILE still exited 1 (measured 2026-09-12, reproducible; the
// base file on the same tree exits 0).
//
// The defect these guard is NOT Temporal-specific and not standalone-link
// specific — see the `#5383 S2n findings` section of the issue file. It is the
// #2927 array-mutation data-loss bug, reopened for `compileProject` only.

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile, compileProject, instantiateLinkedProject } from "../src/index.js";

describe("#5383 S2n R17 — the `$__vec_base` push/pop arm must not depend on pass order", () => {
  // THE DEFECT. `fillClosedMethodDispatch`'s `$__vec_base` brand arm (#2927)
  // routes `.push`/`.pop` on an `any`/externref receiver that is really a
  // native vec to `__vec_push`/`__vec_pop`. It looked that helper up with a
  // plain `resolveVecHostBridgeHelper`, and the ALLOCATION that lookup needs is
  // made by `emitVecAccessExports` — which the two generate entry points call
  // on OPPOSITE SIDES of this fill:
  //
  //   `generateModule`      → emitVecAccessExports BEFORE the fill
  //   `generateMultiModule` → emitVecAccessExports AFTER  the fill
  //
  // So the arm was present in a single-module compile and SILENTLY DROPPED in
  // every multi-module one: `.pop()` fell to the open-`$Object` bottom arm,
  // returned `undefined` and mutated nothing. That is the #2927 data-loss bug
  // reopened for `compileProject` only, on `--target standalone` / `--target
  // wasi`. It needs no link at all — a single-FILE `compileProject`
  // (`plan=none`) reproduces it.
  //
  // Why it surfaced as a Temporal number: JSBI's `__trim` truncates a BigInt's
  // digit array with `this.pop()` inside a method of `class JSBI extends
  // Array`. With `pop` a no-op a zero result keeps its zero digits, so
  // `JSBI.subtract(x, x)` answered 536870912 (2^29) instead of 0,
  // `JSBI.remainder(3600000000000n, 60000000000n)` answered a 3-digit value
  // instead of 0, and `TimeDuration.fdiv` — whose last line is
  // `Number(abs(q).toString() + "." + digits.join(""))` — produced NaN. Hence
  // `Temporal.Duration.from({hours:1}).total("minutes")` crossing the link as a
  // boxed NaN, which is exactly what S2m measured and mis-read as a decode
  // failure.
  //
  // The fix is resolve-OR-RESERVE at the fill, so the arm is order-INDEPENDENT
  // rather than order-correct. Byte A/B: 12 module shapes × {gc, standalone},
  // all 24 single-module artifacts sha256-identical (`.tmp/s2n-ab.mts`).
  // ONE call site per module on purpose. A `.push(…)` anywhere in the module
  // makes the CALL SITE reserve the vec bridge (call-receiver-method.ts), which
  // allocates it before the fill and MASKS the pop defect entirely — measured:
  // adding a single `p_push` export to this same source made the base tree
  // answer 0 for `p_trim`. A combined source is therefore not a regression
  // guard at all.
  const CLASS = [
    "class C extends Array {",
    "  constructor(n, sign) { super(n); this.sign = sign; }",
    "  setDigit(i, v) { this[i] = v; }",
    "  trim() { let i = this.length, last = this[i - 1];",
    "    for (; last === 0; ) { i--; last = this[i - 1]; this.pop(); }",
    "    return this; }",
    "}",
    "function mk3() { const c = new C(3, false); c.setDigit(0, 0); c.setDigit(1, 0); c.setDigit(2, 0); return c; }",
  ].join("\n");
  const POP_SOURCE = `${CLASS}\nexport function probe() { return mk3().trim().length; }\n`;
  const PUSH_SOURCE = `${CLASS}\nexport function probe() { const c = new C(0, false); c.push(7); return c.length; }\n`;

  const OPTIONS = {
    target: "standalone",
    hostBridge: "off",
    allowJs: true,
    skipSemanticDiagnostics: true,
    emitWat: false,
  } as const;

  async function bothLanes(source: string): Promise<{ solo: number; project: number }> {
    const solo = await compile(source, { ...OPTIONS, fileName: "/s2n-solo.js" });
    expect(solo.success).toBe(true);
    const soloInstance = (await WebAssembly.instantiate(solo.binary, {})).instance;

    const root = mkdtempSync(join(tmpdir(), "issue-5383-s2n-"));
    const entry = join(root, "entry.js");
    writeFileSync(entry, source);
    const project = await compileProject(entry, { ...OPTIONS, packageCacheDir: join(root, "providers") });
    expect(project.success).toBe(true);
    const { instance } = await instantiateLinkedProject(project, {});
    return {
      solo: (soloInstance.exports as Record<string, () => number>).probe(),
      project: (instance.exports as Record<string, () => number>).probe(),
    };
  }

  it(
    "`this.pop()` inside an `extends Array` method truncates under compileProject, not only under compile (standalone)",
    { timeout: 600_000 },
    async () => {
      // node: 0. Base: solo 0, project 3 (the pop was a silent no-op).
      expect(await bothLanes(POP_SOURCE)).toEqual({ solo: 0, project: 0 });
    },
  );

  it(
    "`this.push(v)` inside an `extends Array` method appends under compileProject too (standalone)",
    { timeout: 600_000 },
    async () => {
      expect(await bothLanes(PUSH_SOURCE)).toEqual({ solo: 1, project: 1 });
    },
  );
});
