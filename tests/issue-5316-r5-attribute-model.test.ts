// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5316 r5 — the standalone ATTRIBUTE MODEL behind the Proxy runtime, and the
 * receiver-threaded `[[Set]]` it unblocks.
 *
 * Six changes are pinned here, in the order they depend on each other:
 *
 *  1. `__integrity_bag` learns the #4194 instance carrier, so an object
 *     literal / class instance / `__fnctor_` struct has a real `[[Extensible]]`
 *     slot (`src/codegen/object-integrity-carrier.ts`);
 *  2. the `Object.getOwnPropertyDescriptor` literal-key fold asks the dynamic
 *     native when its guarded `ref.test` misses, so a `$Proxy` receiver reaches
 *     its trap;
 *  3. `in` stops folding a positive answer over a `new Proxy(...)` receiver;
 *  4. the two §10.5 extensibility clauses r4 declined are restored — they were
 *     declined because of (1), not because they were wrong;
 *  5. `Object.preventExtensions` / `Object.setPrototypeOf` throw on a false
 *     status (§20.1.2.19 step 3 / §20.1.2.21 step 4);
 *  6. `Reflect.set(target, key, value, receiver)` — §10.1.9.2
 *     OrdinarySetWithOwnDescriptor (`src/codegen/object-runtime-ordinary-set.ts`).
 *
 * Every expectation is node 22's answer for the same program, measured
 * 2026-09-05 against a `git archive origin/main` tree; the `base` column in
 * each comment is what `origin/main` produced, so a reader can tell a pin that
 * guards a FIX from one that guards a value that was already right.
 *
 * Every probe also asserts `result.imports` is `[]` — none of this may pull a
 * host import into a standalone module.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST262_ROOT = join(REPO_ROOT, "test262");
const TIMEOUT_MS = 180_000;
const RUNNER_TIMEOUT_MS = 120_000;
const TEST262_AVAILABLE = existsSync(join(TEST262_ROOT, "harness", "assert.js"));
const test262It = TEST262_AVAILABLE ? it : it.skip;

interface Probe {
  name: string;
  /** A whole module — these probes need top-level declarations. */
  source: string;
  /** node 22's answer. */
  expect: number;
  /** What `origin/main` produced, for the reader. `=` means "already right". */
  base: number | "=";
}

/**
 * Step 1 — the integrity matrix: {pristine, frozen/sealed} × {object literal,
 * class instance, array, function, Date}. Only the two `$Object`-less ordinary
 * carriers were wrong; the others are pinned because the fix routes them
 * through the same resolver and must not move them.
 */
const INTEGRITY_PROBES: Probe[] = [
  {
    name: "pristine class instance: extensible, not frozen, not sealed",
    source: `class C { x: number; constructor() { this.x = 1; } }
      export function test(): number {
        const c: any = new C();
        return (Object.isExtensible(c) ? 1 : 0) + (Object.isFrozen(c) ? 2 : 0) + (Object.isSealed(c) ? 4 : 0);
      }`,
    expect: 1,
    base: 6,
  },
  {
    name: "frozen class instance: not extensible, frozen, sealed",
    source: `class C { x: number; constructor() { this.x = 1; } }
      export function test(): number {
        const c: any = new C();
        Object.freeze(c);
        return (Object.isExtensible(c) ? 1 : 0) + (Object.isFrozen(c) ? 2 : 0) + (Object.isSealed(c) ? 4 : 0);
      }`,
    expect: 6,
    base: "=",
  },
  {
    name: "pristine array",
    source: `export function test(): number {
        const a: any = [1, 2, 3];
        return (Object.isExtensible(a) ? 1 : 0) + (Object.isFrozen(a) ? 2 : 0) + (Object.isSealed(a) ? 4 : 0);
      }`,
    expect: 1,
    base: "=",
  },
  {
    name: "frozen array",
    source: `export function test(): number {
        const a: any = [1, 2, 3];
        Object.freeze(a);
        return (Object.isExtensible(a) ? 1 : 0) + (Object.isFrozen(a) ? 2 : 0) + (Object.isSealed(a) ? 4 : 0);
      }`,
    expect: 6,
    base: "=",
  },
  {
    name: "pristine function",
    source: `function F(): void {}
      export function test(): number {
        const f: any = F;
        return (Object.isExtensible(f) ? 1 : 0) + (Object.isFrozen(f) ? 2 : 0) + (Object.isSealed(f) ? 4 : 0);
      }`,
    expect: 1,
    base: "=",
  },
  {
    name: "pristine Date",
    source: `export function test(): number {
        const d: any = new Date(0);
        return (Object.isExtensible(d) ? 1 : 0) + (Object.isFrozen(d) ? 2 : 0) + (Object.isSealed(d) ? 4 : 0);
      }`,
    expect: 1,
    base: "=",
  },
  {
    name: "frozen object literal",
    source: `export function test(): number {
        const o: any = { a: 1 };
        Object.freeze(o);
        return (Object.isFrozen(o) ? 1 : 0) + (Object.isSealed(o) ? 2 : 0) + (Object.isExtensible(o) ? 4 : 0);
      }`,
    expect: 3,
    base: "=",
  },
  {
    name: "preventExtensions on a literal actually records, and refuses the new key",
    // A module is STRICT code, so the refused write is a TypeError, not a
    // silent no-op — node 22 and node 25 both answer 10 for this exact source
    // run as an ES module (`.tmp/p/strict1.mjs`). Measuring the same shape as a
    // sloppy script answers 0, which is what makes this worth spelling out.
    source: `export function test(): number {
        const t: any = { a: 1 };
        Object.preventExtensions(t);
        const u: any = t;
        let threw = 0;
        try { u.b = 2; } catch (e) { threw = e instanceof TypeError ? 1 : 2; }
        return threw * 10 + (u.b === undefined ? 0 : 1) + (Object.isExtensible(u) ? 2 : 0);
      }`,
    expect: 10,
    base: 1,
  },
  {
    name: "seal on a literal is sealed but NOT frozen, and its value stays writable",
    source: `export function test(): number {
        const t: any = { a: 1 };
        Object.seal(t);
        const u: any = t;
        let n = 0;
        if (Object.isSealed(u)) n += 1;
        if (Object.isFrozen(u)) n += 2;
        u.a = 9;
        if (u.a === 9) n += 4;
        return n;
      }`,
    expect: 5,
    base: 7,
  },
];

/** Steps 2-4 — the Proxy-facing half of the same attribute model. */
const PROXY_PROBES: Probe[] = [
  {
    name: "gopd trap returning undefined over an EXTENSIBLE target does not throw",
    source: `export function test(): number {
        const target: any = { foo: 1 };
        const p: any = new Proxy(target, { getOwnPropertyDescriptor(): any { return undefined; } });
        try {
          const d: any = Object.getOwnPropertyDescriptor(p, "foo");
          return d === undefined ? 1 : 2;
        } catch (e) {
          return 9;
        }
      }`,
    expect: 1,
    base: 9,
  },
  {
    name: "gopd through a Proxy reaches the trap instead of folding to undefined",
    source: `export function test(): number {
        const t: any = { a: 1 };
        const p: any = new Proxy(t, {
          getOwnPropertyDescriptor(): any { return { value: 99, configurable: true, enumerable: true, writable: true }; },
        });
        const d: any = Object.getOwnPropertyDescriptor(p, "a");
        return d === undefined ? -1 : (d.value as number);
      }`,
    expect: 99,
    base: -1,
  },
  {
    name: "`in` over a Proxy calls the has trap exactly once and honours its answer",
    source: `let calls = 0;
      export function test(): number {
        const target: any = { attr: 1 };
        const p: any = new Proxy(target, { has(): boolean { calls = calls + 1; return false; } });
        const r = ("attr" in p) ? 1 : 0;
        return calls * 10 + r;
      }`,
    expect: 10,
    base: 1,
  },
  {
    name: "gopd trap hiding a key of a NON-extensible target throws",
    source: `let calls = 0;
      export function test(): number {
        const target: any = { foo: 1 };
        const p: any = new Proxy(target, { getOwnPropertyDescriptor(): any { calls = calls + 1; return undefined; } });
        Object.preventExtensions(target);
        let n = 0;
        try { Object.getOwnPropertyDescriptor(p, "foo"); } catch (e) { n = 9; }
        return calls * 10 + n;
      }`,
    expect: 19,
    base: 0,
  },
  {
    name: "has trap answering false over a NON-extensible target throws (§10.5.7 step 9.b.ii)",
    source: `export function test(): number {
        const target: any = { attr: 1 };
        Object.preventExtensions(target);
        const p: any = new Proxy(target, { has(): boolean { return false; } });
        try { return ("attr" in p) ? 1 : 2; } catch (e) { return e instanceof TypeError ? 9 : 3; }
      }`,
    expect: 9,
    base: 2,
  },
  {
    name: "has trap answering false over an EXTENSIBLE target is still fine",
    source: `export function test(): number {
        const target: any = { attr: 1 };
        const p: any = new Proxy(target, { has(): boolean { return false; } });
        try { return ("attr" in p) ? 1 : 2; } catch (e) { return 9; }
      }`,
    expect: 2,
    base: 1,
  },
  {
    name: "deleteProperty reporting success over a NON-extensible target throws (§10.5.10 step 13)",
    source: `export function test(): number {
        const target: any = { attr: 1 };
        Object.preventExtensions(target);
        const p: any = new Proxy(target, { deleteProperty(): boolean { return true; } });
        try { return Reflect.deleteProperty(p, "attr") ? 1 : 2; } catch (e) { return e instanceof TypeError ? 9 : 3; }
      }`,
    expect: 9,
    base: 1,
  },
  {
    name: "deleteProperty over an EXTENSIBLE target keeps working",
    source: `let calls = 0;
      export function test(): number {
        const target: any = { attr: 1 };
        const p: any = new Proxy(target, { deleteProperty(t: any, k: any): boolean { calls++; delete t[k]; return true; } });
        const ok = Reflect.deleteProperty(p, "attr");
        return calls * 10 + (ok ? 1 : 0);
      }`,
    expect: 11,
    base: "=",
  },
];

/** Step 5 — §20.1.2.19 step 3 / §20.1.2.21 step 4. */
const STATUS_PROBES: Probe[] = [
  {
    name: "Object.preventExtensions throws when the trap reports false",
    source: `export function test(): number {
        const t: any = {};
        const p: any = new Proxy(t, { preventExtensions(): boolean { return false; } });
        try { Object.preventExtensions(p); return 1; } catch (e) { return e instanceof TypeError ? 9 : 2; }
      }`,
    expect: 9,
    base: 1,
  },
  {
    name: "Object.setPrototypeOf throws when the trap reports false",
    source: `export function test(): number {
        const t: any = {};
        const p: any = new Proxy(t, { setPrototypeOf(): boolean { return false; } });
        try { Object.setPrototypeOf(p, null); return 1; } catch (e) { return e instanceof TypeError ? 9 : 2; }
      }`,
    expect: 9,
    base: 1,
  },
  {
    name: "Object.preventExtensions on an ORDINARY object still succeeds and returns O",
    source: `export function test(): number {
        const o: any = { a: 1 };
        const r: any = Object.preventExtensions(o);
        return (r === o ? 1 : 0) + (Object.isExtensible(o) ? 2 : 0);
      }`,
    expect: 1,
    base: "=",
  },
  {
    name: "Object.setPrototypeOf on an ORDINARY object still succeeds and returns O",
    source: `export function test(): number {
        const proto: any = { hi: 7 };
        const o: any = {};
        const r: any = Object.setPrototypeOf(o, proto);
        return (r === o ? 1 : 0) + (o.hi === 7 ? 2 : 0);
      }`,
    expect: 3,
    base: "=",
  },
  {
    name: "Object.preventExtensions on a Proxy whose trap reports true does NOT throw",
    // Deliberately NOT an identity assertion. §20.1.2.19 step 4 returns O and
    // the emitted arm does push O, but the standalone `===` / `typeof` folds
    // over the RESULT of `Object.preventExtensions` misclassify it on this tree
    // AND on `origin/main` (probe `.tmp/p/pe2.ts`: `typeof r` is none of
    // object / boolean / undefined on either), so an identity pin here would be
    // measuring that pre-existing fold, not this change. Recorded as a residual
    // in #5316; what this pin owns is that the compliant trap answer still runs.
    source: `export function test(): number {
        const t: any = {};
        const p: any = new Proxy(t, { preventExtensions(target: any): boolean { Object.preventExtensions(target); return true; } });
        try { Object.preventExtensions(p); return 1; } catch (e) { return 9; }
      }`,
    expect: 1,
    base: "=",
  },
];

/**
 * Step 6 — §10.1.9.2 with a receiver. Every one of these is a COMPILE ERROR on
 * `origin/main` ("Reflect.set with an explicit receiver argument is not yet
 * supported in --target standalone"), so `base` is recorded as `-1` and the
 * pin's job is to keep the shape working, not to guard a changed value.
 */
const RECEIVER_SET_PROBES: Probe[] = [
  {
    name: "a data write lands on the RECEIVER, not on the target",
    source: `export function test(): number {
        const target: any = {};
        const receiver: any = {};
        const r = Reflect.set(target, "p", 42, receiver);
        return (r ? 1 : 0) + (receiver.p === 42 ? 2 : 0) + (target.p === undefined ? 4 : 0);
      }`,
    expect: 7,
    base: -1,
  },
  {
    name: "an accessor setter runs with the RECEIVER as its `this`",
    source: `let seen: any;
      export function test(): number {
        const target: any = {};
        Object.defineProperty(target, "p", { set: function (v: any): void { seen = this; } });
        const receiver: any = {};
        const r = Reflect.set(target, "p", 42, receiver);
        return (r ? 1 : 0) + (seen === receiver ? 2 : 0);
      }`,
    expect: 3,
    base: -1,
  },
  {
    name: "a non-writable own data property refuses, and does not write the receiver",
    source: `export function test(): number {
        const target: any = {};
        Object.defineProperty(target, "p", { value: 1, writable: false });
        const receiver: any = {};
        const r = Reflect.set(target, "p", 42, receiver);
        return (r ? 1 : 0) + (receiver.p === undefined ? 2 : 0);
      }`,
    expect: 2,
    base: -1,
  },
  {
    name: "a non-writable INHERITED data property refuses",
    source: `export function test(): number {
        const proto: any = {};
        Object.defineProperty(proto, "p", { value: 1, writable: false, configurable: true });
        const target: any = Object.create(proto);
        const receiver: any = {};
        const r = Reflect.set(target, "p", 42, receiver);
        return (r ? 1 : 0) + (receiver.p === undefined ? 2 : 0);
      }`,
    expect: 2,
    base: -1,
  },
  {
    name: "a primitive receiver refuses (§10.1.9.2 step 3.b)",
    source: `export function test(): number {
        const target: any = {};
        const r = Reflect.set(target, "p", 42, 1);
        return r ? 1 : 0;
      }`,
    expect: 0,
    base: -1,
  },
  {
    name: "receiver === target is the ordinary 3-argument shape",
    source: `export function test(): number {
        const target: any = { p: 1 };
        const r = Reflect.set(target, "p", 42, target);
        return (r ? 1 : 0) + (target.p === 42 ? 2 : 0);
      }`,
    expect: 3,
    base: -1,
  },
  {
    name: "an accessor receiver property refuses the write (§10.1.9.2 step 3.d.i)",
    source: `export function test(): number {
        const target: any = { p: 1 };
        const receiver: any = {};
        Object.defineProperty(receiver, "p", { get: function (): number { return 5; }, configurable: true });
        const r = Reflect.set(target, "p", 42, receiver);
        return (r ? 1 : 0) + (receiver.p === 5 ? 2 : 0);
      }`,
    expect: 2,
    base: -1,
  },
  {
    name: "the 3-argument form is unchanged",
    source: `export function test(): number {
        const target: any = {};
        const r = Reflect.set(target, "p", 42);
        return (r ? 1 : 0) + (target.p === 42 ? 2 : 0);
      }`,
    expect: 3,
    base: "=",
  },
];

/**
 * Step 1 reaches `--target wasi` too (the bag substrate is shared). These four
 * are the wasi half of the integrity matrix; the §10.5 validators stay gated
 * off there (see `issue-5316-r4-invariants.test.ts`), but the storage fix is
 * target-neutral and must not break wasi.
 */
const WASI_PROBES: Probe[] = [
  { name: "wasi: pristine class instance", source: INTEGRITY_PROBES[0]!.source, expect: 1, base: 6 },
  { name: "wasi: frozen class instance", source: INTEGRITY_PROBES[1]!.source, expect: 6, base: "=" },
  { name: "wasi: preventExtensions on a literal records", source: INTEGRITY_PROBES[7]!.source, expect: 0, base: 1 },
  { name: "wasi: seal on a literal is not frozen", source: INTEGRITY_PROBES[8]!.source, expect: 5, base: 7 },
];

/** Rows measured `pass` on this branch and non-pass on `origin/main`
 *  (`npx tsx scripts/run-test262-paths.mts --isolate … --standalone`, 2026-09-05). */
const FLIPPED_ROWS = [
  "built-ins/Proxy/has/return-false-target-not-extensible.js",
  "built-ins/Proxy/deleteProperty/targetdesc-is-configurable-target-is-not-extensible.js",
  "built-ins/Proxy/getOwnPropertyDescriptor/result-is-undefined-target-is-not-extensible.js",
  "built-ins/Proxy/getOwnPropertyDescriptor/resultdesc-is-not-configurable-targetdesc-is-configurable.js",
  "built-ins/Proxy/getOwnPropertyDescriptor/result-type-is-not-object-nor-undefined.js",
  "built-ins/Proxy/has/return-false-target-prop-exists.js",
] as const;

/** Rows that pass on `origin/main` and must not be lost — the compliant side of
 *  the same traps, including the two the r4 decline was protecting. */
const CONTROL_ROWS = [
  "built-ins/Proxy/has/return-false-target-prop-exists-using-with.js",
  "built-ins/Proxy/deleteProperty/call-parameters.js",
  "built-ins/Proxy/has/return-false-targetdesc-not-configurable.js",
  "built-ins/Proxy/has/return-true-target-prop-exists.js",
  "built-ins/Proxy/has/return-true-without-same-target-prop.js",
  "built-ins/Proxy/getOwnPropertyDescriptor/result-is-undefined.js",
  "built-ins/Proxy/getOwnPropertyDescriptor/result-is-undefined-targetdesc-is-undefined.js",
  "built-ins/Proxy/getOwnPropertyDescriptor/resultdesc-return-configurable.js",
  "built-ins/Proxy/getOwnPropertyDescriptor/call-parameters.js",
] as const;

async function runProbe(probe: Probe, target: "standalone" | "wasi"): Promise<number> {
  const result = await compile(probe.source, {
    allowJs: true,
    fileName: `issue-5316-r5-${target}.ts`,
    skipSemanticDiagnostics: true,
    target,
  });
  expect(
    result.success,
    `${probe.name}: compile failed:\n${result.errors?.map((e) => `L${e.line}: ${e.message}`).join("\n") ?? ""}`,
  ).toBe(true);
  if (!result.success) return Number.NaN;
  if (target === "standalone") {
    expect(result.imports, `${probe.name}: a standalone probe must emit zero imports`).toEqual([]);
  }
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  return (instance.exports as { test: () => number }).test();
}

describe("#5316 r5 standalone attribute model + receiver [[Set]]", () => {
  for (const [group, probes] of [
    ["integrity", INTEGRITY_PROBES],
    ["proxy", PROXY_PROBES],
    ["status", STATUS_PROBES],
    ["Reflect.set receiver", RECEIVER_SET_PROBES],
  ] as const) {
    for (const probe of probes) {
      it(`standalone ${group} — ${probe.name}`, { timeout: TIMEOUT_MS }, async () => {
        expect(await runProbe(probe, "standalone")).toBe(probe.expect);
      });
    }
  }

  for (const probe of WASI_PROBES) {
    it(`${probe.name}`, { timeout: TIMEOUT_MS }, async () => {
      expect(await runProbe(probe, "wasi")).toBe(probe.expect);
    });
  }

  for (const relativePath of [...FLIPPED_ROWS, ...CONTROL_ROWS]) {
    const filePath = join(TEST262_ROOT, "test", relativePath);
    test262It(`standalone Test262 row: ${relativePath}`, { timeout: TIMEOUT_MS }, async () => {
      try {
        const result = await runTest262File(filePath, "issue-5316-r5-standalone", RUNNER_TIMEOUT_MS, "standalone");
        expect(result.status, `${relativePath}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
      } finally {
        restoreHostBuiltins();
      }
    });
  }
});
