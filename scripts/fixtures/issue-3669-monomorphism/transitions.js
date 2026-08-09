// Copyright (C) 2026 the V8 project authors. All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.
/*---
description: characterise property-slot monomorphism — scope and which transitions (#3669)
esid: pending
flags: [noStrict]
---*/
// NOTE ON SHAPE: arms are written INLINE. Wrapping each arm in a
// `function(){...return o.p === x}` trips an unrelated codegen bug
// (`call[0] expected type externref, found if of type f64`), so the helper form
// cannot be used here — a CompileError would masquerade as a finding.

var report = "";
function note(t) {
  report = report + t + " ";
}
if (1 === 2) {
  note("CTL0:BAD");
} else {
  note("CTL0:ok");
}

// ---------- same-type controls: these MUST pass ----------
var ca = {};
ca.p = 1;
ca.p = 2;
if (ca.p === 2) {
  note("C.num>num:ok");
} else {
  note("C.num>num:BROKEN");
}
var cb = {};
cb.p = "a";
cb.p = "b";
if (cb.p === "b") {
  note("C.str>str:ok");
} else {
  note("C.str>str:BROKEN");
}
var cc = {};
cc.p = true;
cc.p = false;
if (cc.p === false) {
  note("C.bool>bool:ok");
} else {
  note("C.bool>bool:BROKEN");
}

// ---------- transition matrix ----------
var a1 = {};
a1.p = 1;
a1.p = "s";
if (a1.p === "s") {
  note("num>str:ok");
} else {
  note("num>str:BROKEN");
}

var a2 = {};
a2.p = 1;
a2.p = true;
if (a2.p === true) {
  note("num>bool:ok");
} else {
  note("num>bool:BROKEN");
}

var a3 = {};
a3.p = 1;
a3.p = null;
if (a3.p === null) {
  note("num>null:ok");
} else {
  note("num>null:BROKEN");
}

var a4 = {};
a4.p = 1;
a4.p = undefined;
if (a4.p === undefined) {
  note("num>undef:ok");
} else {
  note("num>undef:BROKEN");
}

var ox = {};
var a5 = {};
a5.p = 1;
a5.p = ox;
if (a5.p === ox) {
  note("num>obj:ok");
} else {
  note("num>obj:BROKEN");
}

var a6 = {};
a6.p = "s";
a6.p = 2;
if (a6.p === 2) {
  note("str>num:ok");
} else {
  note("str>num:BROKEN");
}

var a7 = {};
a7.p = "s";
a7.p = true;
if (a7.p === true) {
  note("str>bool:ok");
} else {
  note("str>bool:BROKEN");
}

var oy = {};
var a8 = {};
a8.p = "s";
a8.p = oy;
if (a8.p === oy) {
  note("str>obj:ok");
} else {
  note("str>obj:BROKEN");
}

var a9 = {};
a9.p = true;
a9.p = 3;
if (a9.p === 3) {
  note("bool>num:ok");
} else {
  note("bool>num:BROKEN");
}

var a10 = {};
a10.p = true;
a10.p = "s";
if (a10.p === "s") {
  note("bool>str:ok");
} else {
  note("bool>str:BROKEN");
}

var oz = {};
var a11 = {};
a11.p = oz;
a11.p = 4;
if (a11.p === 4) {
  note("obj>num:ok");
} else {
  note("obj>num:BROKEN");
}

var ow = {};
var a12 = {};
a12.p = ow;
a12.p = "s";
if (a12.p === "s") {
  note("obj>str:ok");
} else {
  note("obj>str:BROKEN");
}

// ---------- per-SLOT or per-SHAPE? ----------
var s1 = {};
s1.p = 1;
s1.p = "s";
var s2 = {};
s2.p = "s";
if (s2.p === "s") {
  note("shape-sibling:ok");
} else {
  note("shape-sibling:BROKEN");
}

// ---------- literal initialiser vs assignment ----------
var L1 = { p: 1 };
L1.p = "s";
if (L1.p === "s") {
  note("literal-num>str:ok");
} else {
  note("literal-num>str:BROKEN");
}

var L2 = { p: "a" };
L2.p = "b";
if (L2.p === "b") {
  note("C.literal-str>str:ok");
} else {
  note("C.literal-str>str:BROKEN");
}

// ---------- does a THIRD write recover the slot? ----------
var r = {};
r.p = 1;
r.p = "s";
r.p = "t";
if (r.p === "t") {
  note("third-write:recovers");
} else {
  note("third-write:still-broken");
}

// ---------- is the corrupted value self-unequal (sNaN-like)? ----------
var z = {};
z.p = 1;
z.p = "s";
var zv = z.p;
if (zv !== zv) {
  note("corrupt:self-unequal");
} else {
  note("corrupt:self-equal");
}

throw new Test262Error("P6 " + report);
