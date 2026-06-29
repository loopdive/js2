const r1 = /foo.*bar/gi;
const r2 = /[a-z]+\d?/u;
const r3 = /(?<year>\d{4})-(?<month>\d{2})/;
const r4 = /\p{Letter}/u;
const matched = "abc".replace(/b/, "B");
