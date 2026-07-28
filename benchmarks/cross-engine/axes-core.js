// Shared microbenchmark body — plain ES5 so node, Porffor and js2 all accept it.
// Each bench isolates ONE axis and returns a checksum so nothing can be
// optimised away as dead code.

// Axis 1: pure numeric work. No objects, no strings. Measures value
// representation (unboxed machine number vs heap-boxed) and loop codegen.
function benchNumeric() {
  var s = 0;
  for (var i = 0; i < 1000000; i++) {
    s = s + i * 2 - (i >> 1);
  }
  return s;
}

// Axis 2: monomorphic property read/write on a plain object. Measures how a
// named property resolves: fixed slot offset vs hash/ladder lookup.
function benchProp() {
  var o = { a: 1, b: 2, c: 3 };
  var s = 0;
  for (var i = 0; i < 300000; i++) {
    o.a = o.a + 1;
    s = s + o.a + o.b + o.c;
  }
  return s;
}

// Axis 3: prototype method dispatch on a constructor instance.
function P(v) {
  this.v = v;
}
P.prototype.inc = function () {
  this.v = this.v + 1;
  return this.v;
};
function benchMethod() {
  var p = new P(0);
  var s = 0;
  for (var i = 0; i < 300000; i++) {
    s = s + p.inc();
  }
  return s;
}

// Axis 4: string scanning — the tokenizer inner loop shape.
function benchString(src) {
  var s = 0;
  for (var i = 0; i < src.length; i++) {
    s = s + src.charCodeAt(i);
  }
  return s;
}

// Axis 5: short-lived object allocation (GC / allocator throughput).
function benchAlloc() {
  var s = 0;
  for (var i = 0; i < 100000; i++) {
    var o = { x: i, y: i + 1 };
    s = s + o.x + o.y;
  }
  return s;
}

// Axis 6: the acorn tokenizer shape — a constructor instance whose methods
// read/write `this.<field>` and call `this.<method>()` in a loop. This is
// what a real parser's inner loop looks like, and it is the shape that
// static monomorphisation has to survive.
function Tok(input) {
  this.input = input;
  this.pos = 0;
  this.acc = 0;
}
Tok.prototype.nextCode = function () {
  var c = this.input.charCodeAt(this.pos);
  this.pos = this.pos + 1;
  return c;
};
Tok.prototype.run = function () {
  while (this.pos < this.input.length) {
    this.acc = this.acc + this.nextCode();
  }
  return this.acc;
};
function benchTokenizer(src) {
  var t = new Tok(src);
  return t.run();
}
