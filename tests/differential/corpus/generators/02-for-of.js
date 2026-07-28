function* range(start, end) {
  for (let i = start; i < end; i++) yield i;
}
const out = [];
for (const x of range(2, 7)) out.push(x * x);
console.log(out.join(","));
console.log([...range(0, 3)].length);
