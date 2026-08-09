function* gen() {
  try {
    yield 1;
    yield 2;
  } finally {
    console.log("cleanup");
  }
  return 0;
}

const a = gen();
console.log(a.next().value);
const r = a.return(99);
console.log(r.value + "," + r.done);

const b = gen();
console.log(b.next().value);
try {
  b.throw(new Error("boom"));
} catch (e) {
  console.log("caught: " + e.message);
}
