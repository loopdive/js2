// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Untyped JS on purpose (#6884): the reduction of the Temporal polyfill's
// `d.subtract(c)` (two `TimeDuration`s whose `totalNs` is a JSBI, i.e. a
// `class extends Array`). `pick` comes from JSON.parse, so `c` and `d` are
// untyped and `d.subtract(c)` is a dynamic `__extern_method_call` that lands
// on the compiled class-method host bridge. A second class with the same
// method names keeps the call from being resolved statically.

class Big extends Array {
  constructor(n) {
    super(n);
    this.sign = false;
  }
  __digit(i) {
    return this[i];
  }
  static from(v) {
    const b = new Big(1);
    b[0] = v;
    return b;
  }
  static sub(x, y) {
    return Big.from(x.__digit(0) - y.__digit(0));
  }
}

class TD {
  constructor(t) {
    this.totalNs = t;
  }
  round(n) {
    return new TD(Big.from(Math.ceil(this.totalNs.__digit(0) / n) * n));
  }
  subtract(t) {
    return new TD(Big.sub(this.totalNs, t.totalNs));
  }
  isTD(t) {
    return t instanceof TD;
  }
}

class Other {
  round() {
    return 0;
  }
  subtract() {
    return 0;
  }
  isTD() {
    return "other";
  }
}

function viaDynamicReceiver(c, n) {
  const d = c.round(n);
  return [d.isTD(c), d.subtract(c).totalNs.__digit(0)].join(":");
}

export function dynamicSubtract() {
  const pick = JSON.parse("1");
  const c = pick === 1 ? new TD(Big.from(5)) : new Other();
  try {
    return viaDynamicReceiver(c, 10);
  } catch (e) {
    return "THROW " + String(e);
  }
}

// Control: the same values through a statically-resolved receiver never
// touch the host bridge, and answered correctly before the fix too.
export function staticSubtract() {
  const c = new TD(Big.from(5));
  const d = c.round(10);
  return [d.isTD(c), d.subtract(c).totalNs.__digit(0)].join(":");
}
