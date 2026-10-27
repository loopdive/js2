// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7164 — `g.length = n` on an externref (`any[]`) vec grew the length field
// only, so the new indices exposed the backing array's default `null` slots:
// `1 in g` was true, `g[1]` read `null`, for-in / Object.keys listed them and
// comparator-less `sort()` moved them first. Growth now reallocates the backing
// (up to the 16M guard) and fills the new slots with the `$Hole` marker, the
// representation the elision literal and the shrink fill already use.
//
// Each program is compiled once per lane (gc native-first, standalone, wasi);
// each read is its own row, diffed against native JS. Rows that still differ
// for reasons outside this issue are `it.fails` with the issue that owns them,
// so a later fix flips the row and has to update this table.
import { beforeAll, describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

const ENC = `function enc(s: string): number { let h = s.length; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000003; return h; }\n`;

const LANES = [
  { lane: "gc", options: {} },
  { lane: "standalone", options: { target: "standalone" } },
  { lane: "wasi", options: { target: "wasi" } },
] as const;
type Lane = (typeof LANES)[number]["lane"];

const PROGRAMS: Record<string, string> = {
  // The issue's program: grow within the capacity `push` reserved.
  grow: `const g: any[] = []; g.push("y"); g.length = 3;`,
  // Shrink to zero, then grow (the shrink fill already marked the slots).
  zeroGrow: `const g: any[] = []; g.push("y"); g.push("z"); g.length = 0; g.length = 2;`,
  // Grow past the capacity, push into the grown range's end, grow again.
  growBig: `const g: any[] = []; g.push("y"); g.length = 9; g.push("z"); g.length = 12;`,
  // The append shape: an element write bumps length before the length store.
  append: `const g: any[] = ["a"]; g[1] = "b"; g.length = 2; g[g.length] = "c"; g.length = g.length;`,
  // Other hole sources the plan lists — their gaps are owned by #7169 / #7170 / #7171.
  del: `const g: any[] = []; g.push("y"); g.push("x"); g.push("z"); delete g[1];`,
  newArray: `const g: any[] = new Array(3); g[0] = "y";`,
};

const READS: Record<string, string> = {
  index: `String(g[1])`,
  in: `String(1 in g) + String(2 in g)`,
  hasOwnProperty: `String(g.hasOwnProperty(1))`,
  forIn: `(() => { let s = ""; for (const k in g) s += k + ","; return s; })()`,
  join: `g.join("|")`,
  forEach: `(() => { let n = 0; g.forEach(() => { n++; }); return String(n); })()`,
  map: `(() => { const m = g.map((x: any) => "m" + x); return m.length + ":" + (1 in m) + ":" + m.join("|"); })()`,
  objectKeys: `Object.keys(g).join(",")`,
  json: `JSON.stringify(g)`,
  spread: `(() => { const s = [...g]; return s.length + ":" + (1 in s) + ":" + String(s[1]); })()`,
  sort: `(() => { g.sort(); return g.join("|"); })()`,
};

const NATIVE: readonly Lane[] = ["gc", "standalone"];
const ALL: readonly Lane[] = ["gc", "standalone", "wasi"];
const WASI: readonly Lane[] = ["wasi"];

// Known gaps: program → reads → lanes, with the issue that owns the rows.
const GROWTH = "grow|zeroGrow|growBig";
const GAPS: { program: string; reads: string[]; lanes: readonly Lane[]; owner: string }[] = [
  // `hasOwnProperty` and `map` do not recognise `$Hole` on an externref vec (#7170).
  { program: GROWTH, reads: ["hasOwnProperty"], lanes: NATIVE, owner: "#7170" },
  { program: GROWTH, reads: ["map"], lanes: ALL, owner: "#7170" },
  // `[...g]` copies a hole as a hole instead of reading `undefined` (untracked; see the issue's Resolution).
  { program: GROWTH, reads: ["spread"], lanes: NATIVE, owner: "spread-of-holes" },
  // wasi: `in` and for-in report holes as present (#7171).
  { program: GROWTH, reads: ["in", "forIn"], lanes: WASI, owner: "#7171" },
  // wasi: Object.keys / hasOwnProperty on an `any[]` are wrong even when it is dense (untracked).
  { program: "grow|growBig|append", reads: ["objectKeys"], lanes: WASI, owner: "wasi-vec-own-keys" },
  { program: "append", reads: ["hasOwnProperty"], lanes: WASI, owner: "wasi-vec-own-keys" },
  // `delete g[1]` keeps the value in the slot; reads that skip the deleted-index record see it (#7169 / #7170 / #7171).
  { program: "del", reads: ["join", "forEach", "map", "spread", "sort"], lanes: NATIVE, owner: "#7169/#7170" },
  {
    program: "del",
    reads: ["index", "in", "forIn", "join", "forEach", "map", "objectKeys", "json", "spread", "sort"],
    lanes: WASI,
    owner: "#7171/#7170",
  },
  // `new Array(3)` holes on the native-first lane and the per-read gaps (#7170 / #7171).
  {
    program: "newArray",
    reads: ["in", "hasOwnProperty", "forIn", "forEach", "map", "objectKeys"],
    lanes: NATIVE,
    owner: "#7170",
  },
  { program: "newArray", reads: ["in", "forIn", "forEach", "map", "objectKeys"], lanes: WASI, owner: "#7170/#7171" },
];

function gapFor(program: string, read: string, lane: Lane): string | undefined {
  for (const gap of GAPS) {
    if (gap.program.split("|").includes(program) && gap.reads.includes(read) && gap.lanes.includes(lane)) {
      return gap.owner;
    }
  }
  return undefined;
}

function source(setup: string): string {
  const fns = Object.entries(READS).map(
    ([name, read]) => `export function r_${name}(): number { ${setup} return enc(${read}); }`,
  );
  return `${ENC}${fns.join("\n")}\n`;
}

for (const program of Object.keys(PROGRAMS)) {
  describe(`#7164 ${program}`, () => {
    const src = source(PROGRAMS[program]!);
    const expected = evaluateAsJs(src);
    for (const { lane, options } of LANES) {
      describe(lane, () => {
        let exports: Record<string, unknown> = {};
        beforeAll(async () => {
          const result = await compile(src, { fileName: "probe.ts", ...options });
          expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
          exports = (await instantiateWithRuntime(result)).exports as Record<string, unknown>;
        }, 120_000);
        for (const read of Object.keys(READS)) {
          const gap = gapFor(program, read, lane);
          const test = gap !== undefined ? it.fails : it;
          test(`${read}${gap !== undefined ? ` (known gap: ${gap})` : ""}`, () => {
            const fn = `r_${read}`;
            expect((exports[fn] as () => unknown)(), `${program}/${read}/${lane}`).toBe(expected[fn]!());
          });
        }
      });
    }
  });
}
