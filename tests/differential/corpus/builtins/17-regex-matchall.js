const text = "cat=1 dog=2 fox=3";
const re = /(\w+)=(\d+)/g;
const pairs = [];
for (const m of text.matchAll(re)) {
  pairs.push(m[1] + ":" + m[2]);
}
console.log(pairs.join(","));
console.log([...text.matchAll(re)].length);
