// Copyright (C) 2026 the V8 project authors. All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.
/*---
description: complete boolean-seed row + disputed bool>num, harness lane (#3669)
esid: pending
flags: [noStrict]
---*/
var report = "";
function note(t) {
  report = report + t + " ";
}
if (1 === 2) {
  note("CTL0:BAD");
} else {
  note("CTL0:ok");
}

var b1 = {};
b1.p = true;
b1.p = null;
if (b1.p === null) {
  note("bool>null:ok");
} else {
  note("bool>null:BROKEN");
}

var ob = {};
var b2 = {};
b2.p = true;
b2.p = ob;
if (b2.p === ob) {
  note("bool>obj:ok");
} else {
  note("bool>obj:BROKEN");
}

var b3 = {};
b3.p = true;
b3.p = undefined;
if (b3.p === undefined) {
  note("bool>undef:ok");
} else {
  note("bool>undef:BROKEN");
}

var b4 = {};
b4.p = true;
b4.p = 3;
if (b4.p === 3) {
  note("bool>num:ok");
} else {
  note("bool>num:BROKEN");
}

// num-seed comparison arms, same run
var n1 = {};
n1.p = 1;
n1.p = undefined;
if (n1.p === undefined) {
  note("num>undef:ok");
} else {
  note("num>undef:BROKEN");
}

var n2 = {};
n2.p = 1;
n2.p = true;
if (n2.p === true) {
  note("num>bool:ok");
} else {
  note("num>bool:BROKEN");
}

// reference-seed controls
var oc = {};
var b5 = {};
b5.p = "s";
b5.p = null;
if (b5.p === null) {
  note("C.str>null:ok");
} else {
  note("C.str>null:BROKEN");
}
var b6 = {};
b6.p = oc;
b6.p = null;
if (b6.p === null) {
  note("C.obj>null:ok");
} else {
  note("C.obj>null:BROKEN");
}

throw new Test262Error("P7 " + report);
