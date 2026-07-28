function* inner() {
  yield "a";
  yield "b";
  return "inner-done";
}
function* outer() {
  const result = yield* inner();
  yield "c:" + result;
}
console.log([...outer()].join(","));

function* flatten(arr) {
  for (const x of arr) {
    if (Array.isArray(x)) yield* flatten(x);
    else yield x;
  }
}
console.log([...flatten([1, [2, 3, [4]], 5])].join(","));
