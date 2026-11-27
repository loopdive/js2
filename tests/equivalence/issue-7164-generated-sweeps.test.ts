// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7164 — the generated sweeps over a grown externref vec (the issue's story is
// in issue-7164-externref-vec-length-growth.test.ts; #7565 split the rows
// across three files so the equivalence shards run them in parallel).
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { compile } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";
import { ALL, ENC, FULL_SWEEP, headSummary, LANES, type Lane, pinLane, readSummary } from "./issue-7164-harness.js";
import {
  LEAK_SETUPS,
  LEAK_SUMMARY,
  leaksIn,
  leakFns,
  SWEEP,
  SWEEP_PRELUDE,
  sweepRows,
  sweepSource,
} from "./issue-7164-length-update-sweep-cases.js";

// (#7164 r4) GENERATED leak sweep. Every array-producing method and every call
// form is applied to a grown array; each result array is summarised per index
// as presence (`P` own / `H` absent) plus value class (`u` undefined, `O` a
// non-null object, `v` anything else). A grown slot must never surface as an
// object where node has `undefined` (the internal marker). That check has no
// `it.fails` escape. Full agreement with node (presence included) may be a
// known gap with its owner.
const SWEEP_GROW = `const g: any[] = []; g.push("y"); g.length = 3;`;
// Rows where head differs from node with no marker leak. Measured head vs
// origin/main: none of them was right on origin/main. Growth fills the new
// slots with the canonical `undefined`, so a grown index is present (#7170).
const presence = (lanes: readonly Lane[]) => ({ lanes, owner: "#7170 (grown index is a present undefined)" });
const SWEEP_GAPS: Record<string, { lanes: readonly Lane[]; owner: string }> = {
  // gc/standalone: the grown index is own (`in` true) where node has a hole.
  self: presence(ALL),
  map: presence(ALL),
  filter: presence(ALL),
  slice: presence(ALL),
  concat: presence(ALL),
  flat: presence(ALL),
  flatMap: presence(ALL),
  splice: presence(ALL),
  forEachCollect: presence(ALL),
  reduceCollect: presence(ALL),
  // Same failure on origin/main (untracked): traps, compile errors, `null` reads.
  toSorted: { lanes: ALL, owner: "toSorted-any-vec-trap" },
  arrayFrom: { lanes: ALL, owner: "array-from-any-vec-trap" },
  restObjMethod: { lanes: ALL, owner: "object-literal-method-rest-invalid-wasm" },
  restSuper: { lanes: ALL, owner: "super-spread-rest-empty" },
  dynamicRead: { lanes: ALL, owner: "dynamic-index-read-null" },
  apply: { lanes: ALL, owner: "apply-reads-null" },
};

describe("#7164 generated sweep: matches node", () => {
  for (const [name, expr] of Object.entries(SWEEP)) {
    const src = `${ENC}${SWEEP_PRELUDE}\nexport function test(): number { ${SWEEP_GROW} return enc(sum(${expr})); }`;
    for (const { lane, options } of LANES) {
      const gap = SWEEP_GAPS[name]?.lanes.includes(pinLane(lane)) ? SWEEP_GAPS[name]!.owner : undefined;
      (gap !== undefined ? it.fails : it)(
        `${name} / ${lane}${gap !== undefined ? ` (known gap: ${gap})` : ""}`,
        async () => {
          const result = await compile(src, { fileName: "probe.ts", ...options });
          expect(result.success, `${name}/${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
          const exports = (await instantiateWithRuntime(result)).exports as Record<string, unknown>;
          expect((exports.test as () => unknown)(), `${name}/${lane}`).toBe(evaluateAsJs(src).test!());
        },
        120_000,
      );
    }
  }
});

// (#7164 r5/r6) Marker-leak detector. `$Hole` reads back as `undefined` through
// `r[i]`, so a leak shows as an index node reports PRESENT that head reports
// absent: `i in r` false, or skipped by `forEach`. Each result index is
// summarised as presence (P/H), forEach visit (V/S) and value class (u
// undefined / n null / O object / v other). A leak is node P → head H, node V
// → head S, or node u → head anything but u — so a `null` fill where node has
// `undefined` is a leak. Present-where-node-has-a-hole (H → P) is the accepted
// #7170 gap. Setups cover every grow form and the reallocation path. (#6979
// S7-c: WASI runs the regime, so all three columns count there as well.)
//
// r6: the detector is relative to origin/main. issue-7164-leak-base.json lists,
// per setup/case/lane, the leaks this branch still shares with origin/main at
// the same index and of the same kind (recorded by running the same modules on
// both trees; a leak head has that base lacks was never recorded, because the
// recorder refuses it). Any other leak fails. A cell #7164 fixed is not in the
// list, so regressing it — e.g. filling `null` again — fails.
const LEAK_BASE = JSON.parse(readFileSync(new URL("./issue-7164-leak-base.json", import.meta.url), "utf8")) as Record<
  string,
  Partial<Record<Lane, string[]>>
>;

describe("#7164 generated sweep: no marker leaks", () => {
  const cases = Object.keys(SWEEP);
  for (const [setupName, setup] of Object.entries(LEAK_SETUPS)) {
    const nodeSrc = `${SWEEP_PRELUDE}${LEAK_SUMMARY}\n${leakFns(setup, cases)}`;
    for (const { lane, options } of LANES) {
      describe(`${setupName} / ${lane}`, () => {
        const perCase = new Map<string, ((i: number) => number) | string>();
        beforeAll(async () => {
          // One module per setup; when it does not compile on this lane (known
          // compile gaps), bisect so the failing cases are found in a few compiles.
          const build = async (names: readonly string[]): Promise<void> => {
            const result = await compile(`${SWEEP_PRELUDE}${LEAK_SUMMARY}\n${leakFns(setup, names)}`, {
              fileName: "probe.ts",
              ...options,
            });
            if (result.success) {
              const exports = (await instantiateWithRuntime(result)).exports as Record<string, unknown>;
              for (const name of names) perCase.set(name, exports[`at_${name}`] as (i: number) => number);
            } else if (names.length === 1) {
              perCase.set(names[0]!, result.errors[0]?.message ?? "compile error");
            } else {
              const mid = names.length >> 1;
              await build(names.slice(0, mid));
              await build(names.slice(mid));
            }
          };
          // `restObjMethod` emits invalid wasm on every lane (as on origin/main): its own module.
          await build(cases.filter((name) => name !== "restObjMethod"));
          await build(["restObjMethod"]);
        }, 600_000);
        it("every case", () => {
          const node = evaluateAsJs(nodeSrc);
          const leaks: string[] = [];
          for (const name of cases) {
            const fn = perCase.get(name);
            if (typeof fn !== "function") continue; // does not compile: cannot leak
            let head: string;
            try {
              head = readSummary(fn);
            } catch {
              continue; // a trap is not a leak
            }
            const expected = readSummary(node[`at_${name}`] as (i: number) => number);
            const shared = new Set(LEAK_BASE[`${setupName}/${name}`]?.[pinLane(lane)] ?? []);
            for (const leak of leaksIn(expected, head, pinLane(lane)))
              if (!shared.has(leak)) leaks.push(`${name} ${leak} (node ${expected}, head ${head})`);
          }
          expect(leaks).toEqual([]);
        });
      });
    }
  }
});
// (#7164 r6) Generated length-update sweep: every form (`= n`, `++`, `--`,
// prefix forms, `+= k`, `-= k`) × element type × setup (with and without a
// plain `length =` elsewhere; after push / pop / shrink) × receiver (local,
// parameter, property chain) × lane. It asserts "never worse than
// origin/main": where origin/main matched node, head must match node; where
// origin/main was wrong, head must not trap or fail to compile. The recorded
// origin/main outcomes (rows that did not match node) are in
// issue-7164-length-update-sweep-base.json. By default every 23rd row runs
// (44 rows, covering every form × element pair); JS2WASM_FULL_SWEEP=1 runs all
// 1,008 rows.
const SWEEP_BASE = JSON.parse(
  readFileSync(new URL("./issue-7164-length-update-sweep-base.json", import.meta.url), "utf8"),
) as Record<string, Partial<Record<Lane, "wrong" | "trap">>>;

describe("#7164 length-update sweep: never worse than origin/main", () => {
  const rows = sweepRows().filter((_, i) => FULL_SWEEP || i % 23 === 0);
  for (const row of rows) {
    const src = `${sweepSource(row.form, row.element, row.setup, row.eqElsewhere, row.receiver)}\nexport function at(i: number): number { const s = value(); return i < 0 ? s.length : s.charCodeAt(i); }`;
    for (const { lane, options } of LANES) {
      it(`${row.key} / ${lane}`, async () => {
        const node = readSummary(evaluateAsJs(src).at as (i: number) => number);
        const head = await headSummary(src, options);
        const base = SWEEP_BASE[row.key]?.[pinLane(lane)] ?? "ok";
        if (base === "ok") expect(head, `${row.key}/${lane}`).toBe(node);
        else if (base === "wrong") expect(head, `${row.key}/${lane}`).not.toMatch(/^(TRAP|CE) /);
      }, 120_000);
    }
  }
});
