// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7164 r6 — the generated length-update sweep's cases, shared by the test
// (issue-7164-externref-vec-length-growth.test.ts) and the script that records
// origin/main's outcomes (issue-7164-length-update-sweep-base.json). No vitest
// import: the recorder runs outside vitest.
//
// Dimensions: every length-update form × element type × setup (with and
// without a plain `length =` elsewhere in the module) × receiver shape.

export const FORMS: Record<string, (r: string) => string> = {
  assign: (r) => `${r}.length = 4`,
  postInc: (r) => `${r}.length++`,
  postDec: (r) => `${r}.length--`,
  preInc: (r) => `++${r}.length`,
  preDec: (r) => `--${r}.length`,
  plusEq: (r) => `${r}.length += 2`,
  minusEq: (r) => `${r}.length -= 1`,
};

export const ELEMENTS: Record<string, { type: string; init: string; extra: string }> = {
  anyStr: { type: "any[]", init: "const g: any[] = []; g.push('a'); g.push('b');", extra: "'c'" },
  anyMixed: { type: "any[]", init: "const g: any[] = []; g.push('a'); g.push(1);", extra: "2" },
  string: { type: "string[]", init: "const g: string[] = ['a', 'b'];", extra: "'c'" },
  number: { type: "number[]", init: "const g: number[] = [1, 2];", extra: "3" },
  boolean: { type: "boolean[]", init: "const g: boolean[] = [true, false];", extra: "true" },
  object: { type: "{ x: number }[]", init: "const g: { x: number }[] = [{ x: 1 }, { x: 2 }];", extra: "{ x: 3 }" },
};

export const SETUPS: Record<string, (extra: string) => string> = {
  plain: () => "",
  afterPush: (extra) => `g.push(${extra});`,
  afterPop: () => "g.pop();",
  afterShrink: () => "g.length = 1;",
};

export const RECEIVERS = ["local", "param", "chain"] as const;

/** One sweep row: a module whose `value()` returns the observable summary. */
export function sweepSource(
  form: string,
  element: string,
  setup: string,
  eqElsewhere: boolean,
  receiver: string,
): string {
  const el = ELEMENTS[element]!;
  const update = FORMS[form]!;
  const pre: string[] = [];
  // A plain `length =` elsewhere arms the module's hole-aware reads.
  if (eqElsewhere) pre.push(`function clearElsewhere(a: any[]): void { a.length = 5; }`);
  let apply: string;
  if (receiver === "param") {
    pre.push(`function upd(a: ${el.type}): number { return ${update("a")}; }`);
    apply = "const r = upd(g);";
  } else if (receiver === "chain") {
    apply = `const o = { p: { arr: g } }; const r = ${update("o.p.arr")}; const h = o.p.arr;`;
  } else {
    apply = `const r = ${update("g")};`;
  }
  const subject = receiver === "chain" ? "h" : "g";
  const body = `${el.init} ${SETUPS[setup]!(el.extra)} ${apply}
    let s = String(r) + "|" + ${subject}.length + ":";
    for (let i = 0; i < ${subject}.length + 1; i++) {
      const v: any = ${subject}[i];
      s += (typeof v === "object" && v !== null ? "o" + v.x : String(v)) + (i in ${subject} ? "+" : "-") + ",";
    }
    return s;`;
  return `${pre.join("\n")}\nfunction value(): string { ${body} }`;
}

export interface SweepRow {
  key: string;
  form: string;
  element: string;
  setup: string;
  eqElsewhere: boolean;
  receiver: string;
}

export function sweepRows(): SweepRow[] {
  const rows: SweepRow[] = [];
  for (const form of Object.keys(FORMS))
    for (const element of Object.keys(ELEMENTS))
      for (const setup of Object.keys(SETUPS))
        for (const eqElsewhere of [false, true])
          for (const receiver of RECEIVERS)
            rows.push({
              key: `${form}/${element}/${setup}/${eqElsewhere ? "eq" : "noeq"}/${receiver}`,
              form,
              element,
              setup,
              eqElsewhere,
              receiver,
            });
  return rows;
}

// ── (#7164 r4/r5) The array-producing method and call-form sweep and the marker-leak setups ──

export const SWEEP_PRELUDE = `
function sum(r: any[]): string { let s = r.length + ":"; for (let i = 0; i < r.length; i++) { const v = r[i]; s += (i in r ? "P" : "H") + (v === undefined ? "u" : v === null ? "n" : typeof v === "object" ? "O" : "v"); } return s; }
function fd(...r: any[]): any[] { return r; }
function fdLead(a: any, ...r: any[]): any[] { return r; }
function f3(a: any, b: any, c: any): any[] { return [a, b, c]; }
const fArrow = (...r: any[]): any[] => r;
const fExpr = function (...r: any[]): any[] { return r; };
class KR { m(...r: any[]): any[] { return r; } static s(...r: any[]): any[] { return r; } p(a: any, b: any, c: any): any[] { return [a, b, c]; } }
class CR { r: any[]; constructor(...r: any[]) { this.r = r; } }
class DR extends CR { constructor(...r: any[]) { super(...r); } }
class CP { r: any[]; constructor(a: any, b: any, c: any) { this.r = [a, b, c]; } }
const objM = { m(...r: any[]): any[] { return r; } };
`;

export const SWEEP: Record<string, string> = {
  self: `g`,
  map: `g.map((x: any) => x)`,
  filter: `g.filter(() => true)`,
  slice: `g.slice()`,
  concat: `g.concat([])`,
  flat: `g.flat()`,
  flatMap: `g.flatMap((x: any) => [x])`,
  toReversed: `g.toReversed()`,
  toSorted: `g.toSorted()`,
  toSpliced: `g.toSpliced(0, 0)`,
  with: `g.with(0, "w")`,
  splice: `g.splice(0)`,
  arrayFrom: `Array.from(g)`,
  arrayOf: `Array.of(...g)`,
  entries: `[...g.entries()].map((e: any) => e[1])`,
  values: `[...g.values()]`,
  spread: `[...g]`,
  spreadLead: `[0, ...g]`,
  forEachCollect: `(() => { const o: any[] = []; g.forEach((v: any) => { o.push(v); }); return o; })()`,
  forOfCollect: `(() => { const o: any[] = []; for (const v of g) o.push(v); return o; })()`,
  reduceCollect: `g.reduce((o: any[], v: any) => { o.push(v); return o; }, [] as any[])`,
  indexRead: `[g[0], g[1], g[2]]`,
  dynamicRead: `(() => { const a: any = g; const o: any[] = []; for (let i = 0; i < 3; i++) o.push(a[i]); return o; })()`,
  restDecl: `fd(...g)`,
  restLead: `fdLead(0, ...g)`,
  restArrow: `fArrow(...g)`,
  restExpr: `fExpr(...g)`,
  restMethod: `new KR().m(...g)`,
  restStatic: `KR.s(...g)`,
  restObjMethod: `objM.m(...g)`,
  restClosure: `(() => { const c = "c"; const f = (...r: any[]): any[] => (c ? r : r); return f(...g); })()`,
  restNew: `new CR(...g).r`,
  restSuper: `new DR(...g).r`,
  apply: `(fd as any).apply(null, g)`,
  positionalDecl: `f3(...g)`,
  positionalMethod: `new KR().p(...g)`,
  positionalNew: `new CP(...g).r`,
};

export const LEAK_SETUPS: Record<string, string> = {
  growWithinCapacity: `const g: any[] = []; g.push("y"); g.length = 3;`,
  growReallocates: `const g: any[] = []; g.push("y"); g.push("x"); g.push("w"); g.push("v"); g.length = 9;`,
  shrinkThenPostfixInc: `const g: any[] = []; g.push("y"); g.push("z"); g.length = 1; g.length++; g.length++;`,
  shrinkThenPrefixInc: `const g: any[] = []; g.push("y"); g.push("z"); g.length = 1; ++g.length; ++g.length;`,
  shrinkThenPlusEq: `const g: any[] = []; g.push("y"); g.push("z"); g.push("w"); g.length = 1; g.length += 2;`,
  shrinkThenAssign: `const g: any[] = []; g.push("y"); g.push("z"); g.length = 0; g.length = 3;`,
  clearThenGrow: `const g: any[] = []; g.push("y"); g.push("z"); g.length = 0; g.length += 3;`,
  // (#7164 r6) No plain `length =` anywhere: only the update forms arm the module.
  postIncOnly: `const g: any[] = []; g.push("y"); g.push(1); g.length++; g.length++;`,
  plusEqOnly: `const g: any[] = []; g.push("y"); g.push(1); g.push(2); g.pop(); g.length += 2;`,
};
export const LEAK_SUMMARY = `
function leakSum(r: any[]): string {
  const seen: number[] = []; for (let i = 0; i < r.length; i++) seen.push(0);
  r.forEach((v: any, i: number) => { seen[i] = 1; });
  let s = "";
  for (let i = 0; i < r.length; i++) { const v = r[i]; s += (i in r ? "P" : "H") + (seen[i] === 1 ? "V" : "S") + (v === undefined ? "u" : v === null ? "n" : typeof v === "object" ? "O" : "v"); }
  return s;
}`;
export function leakFns(setup: string, cases: readonly string[]): string {
  return cases
    .map(
      (name) =>
        `export function at_${name}(i: number): number { ${setup} const s = leakSum(${SWEEP[name]}); return i < 0 ? s.length : s.charCodeAt(i); }`,
    )
    .join("\n");
}

/** Leaks in `head` relative to node: see the detector in the test file. */
export function leaksIn(node: string, head: string, lane: string): string[] {
  const out: string[] = [];
  for (let i = 0; i * 3 < node.length; i++) {
    const [np, nv, nc] = node.slice(i * 3, i * 3 + 3);
    const [hp, hv, hc] = head.slice(i * 3, i * 3 + 3);
    if (lane !== "wasi" && np === "P" && hp === "H") out.push(`${i}: present → absent`);
    if (nv === "V" && hv === "S") out.push(`${i}: visited → skipped`);
    if (nc === "u" && hc !== "u")
      out.push(`${i}: undefined → ${hc === "n" ? "null" : hc === "O" ? "object" : "value"}`);
  }
  return out;
}

// ── (#7164 r9) Callback-array escape sweep ──
// A switched binding reached through every receiver shape `classifyUse` looks
// through, handed to every callback method, whose callback updates the length
// through its array parameter. The test asserts head never traps or fails to
// compile where origin/main does not (issue-7164-callback-sweep-base.json).

export const CALLBACK_WRAPPERS: Record<string, (method: string) => string> = {
  plain: (m) => `g.${m}`,
  paren: (m) => `(g).${m}`,
  nonNull: (m) => `g!.${m}`,
  as: (m) => `(g as any[]).${m}`,
  satisfies: (m) => `(g satisfies any[]).${m}`,
  reverse: (m) => `g.reverse().${m}`,
  fill: (m) => `g.fill('f', 5).${m}`,
  copyWithin: (m) => `g.copyWithin(1, 0, 1).${m}`,
  cond: (m) => `(g.length >= 0 ? g : g).${m}`,
  or: (m) => `(g || g).${m}`,
  nullish: (m) => `(g ?? g).${m}`,
  and: (m) => `(g && g).${m}`,
  comma: (m) => `(0, g).${m}`,
  assign: (m) => `(h = g).${m}`,
  element: (m) => `g['${m}']`,
  // (#7164 r10) Wrappers on the method reference, receiver-returning element
  // calls, optional chains, `<T>`, nested wrappers and template keys.
  calleeParen: (m) => `(g.${m})`,
  calleeAs: (m) => `(g.${m} as any)`,
  calleeAngle: (m) => `(<any>g.${m})`,
  calleeNonNull: (m) => `g.${m}!`,
  calleeSatisfies: (m) => `(g.${m} satisfies any)`,
  calleeElemParen: (m) => `(g['${m}'])`,
  calleeComma: (m) => `(0, g.${m})`,
  calleeCond: (m) => `(g.length >= 0 ? g.${m} : g.${m})`,
  angle: (m) => `(<any[]>g).${m}`,
  sort: (m) => `g.sort().${m}`,
  elemReverse: (m) => `g['reverse']().${m}`,
  elemFill: (m) => `g['fill']('f', 5).${m}`,
  calleeReverse: (m) => `(g.reverse)().${m}`,
  calleeFill: (m) => `(g.fill)('f', 5).${m}`,
  calleeCopyWithin: (m) => `(g.copyWithin)(1, 0, 1).${m}`,
  nonNullReverse: (m) => `g.reverse!().${m}`,
  optional: (m) => `g?.${m}`,
  optionalCall: (m) => `g.${m}?.`,
  optionalElem: (m) => `g?.['${m}']`,
  nested: (m) => `((g as any[])!).${m}`,
  template: (m) => `g[\`${m}\`]`,
};
export const CALLBACK_METHODS = [
  "forEach",
  "map",
  "filter",
  "some",
  "every",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "reduce",
  "reduceRight",
] as const;
export const CALLBACK_FORMS: Record<string, string> = {
  assign: "a.length = 9",
  plusEq: "a.length += 7",
  postInc: "a.length++",
  preInc: "++a.length",
  minusEq: "a.length -= 1",
};

export function callbackSource(wrapper: string, method: string, form: string): string {
  const reduce = method === "reduce" || method === "reduceRight";
  const update = CALLBACK_FORMS[form]!;
  const callback = reduce
    ? `(acc: any, v: any, i: number, a: any[]) => { if (i === 0 || i === 1) { ${update}; } return acc; }`
    : `(v: any, i: number, a: any[]) => { if (i === 0 || i === 1) { ${update}; } return ${method === "flatMap" ? "[v]" : "false"}; }`;
  const call = `${CALLBACK_WRAPPERS[wrapper]!(method)}(${callback}${reduce ? ", 0" : ""})`;
  return `function value(): string {
    const g: any[] = []; g.push('a'); g.length = 2; let h: any[] = [];
    ${call};
    let s = String(g.length) + ":";
    for (let i = 0; i < g.length; i++) s += String(g[i]) + ",";
    return s + (h.length >= 0 ? "" : "");
  }
export function at(i: number): number { const s = value(); return i < 0 ? s.length : s.charCodeAt(i); }`;
}

export function callbackRows(): { key: string; wrapper: string; method: string; form: string }[] {
  const rows: { key: string; wrapper: string; method: string; form: string }[] = [];
  for (const wrapper of Object.keys(CALLBACK_WRAPPERS))
    for (const method of CALLBACK_METHODS)
      for (const form of Object.keys(CALLBACK_FORMS))
        rows.push({ key: `${wrapper}/${method}/${form}`, wrapper, method, form });
  return rows;
}

// ── (#7164 r11) Assignment-target sweep ──
// An element or `length` of a switched binding written as a for-of / for-in
// target, inside a destructuring pattern, through a wrapper, or through a
// receiver-returning call. Only a plain store on the bare binding takes the
// new path; every other target leaves the binding unswitched, so head must
// not fail where origin/main does not (issue-7164-target-sweep-base.json).
export const TARGET_FORMS: Record<string, string> = {
  forOfElem: "for (g[0] of ['p', 'q']) {}",
  forOfElem1: "const ys: string[] = ['p']; for (g[1] of ys) {}",
  forOfElem5: "for (g[5] of ['p', 'q']) {}",
  forOfElemString: "for (g[0] of 'pq') {}",
  forOfPattern: "for ([g[0]] of [['p']]) {}",
  forOfReverse: "for (g.reverse()[0] of ['q']) {}",
  forOfLength: "for (g.length of [9]) {}",
  forInElem: "for (g[0] in { k: 1 }) {}",
  arrayPatternLength: "[g.length] = [9];",
  objectPatternLength: "({ a: g.length } = { a: 9 });",
  patternDefaultLength: "[g.length = 9] = [];",
  arrayPatternElem: "[g[5]] = ['x'];",
  reversePatternLength: "[g.reverse().length] = [9];",
  reversePlusEq: "g.reverse().length += 7;",
  reverseAssign: "g.reverse().length = 9;",
  reverseElem: "g.reverse()[0] = 'x';",
  asLength: "(g.length as any) = 9;",
  nonNullLength: "g.length! = 9;",
  asElem: "(g[0] as any) = 'x';",
  parenLength: "(g).length = 9;",
  plainLength: "g.length = 9;",
  plainPlusEq: "g.length += 7;",
};

export function targetSource(form: string): string {
  return `function value(): string {
    const g: any[] = []; g.push('a'); g.length = 2;
    ${TARGET_FORMS[form]!}
    return String(g[0]) + ":" + String(g[8]) + ":" + g.length;
  }
export function at(i: number): number { const s = value(); return i < 0 ? s.length : s.charCodeAt(i); }`;
}
