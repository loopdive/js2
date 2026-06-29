function* gen() { yield 1; yield* [2, 3]; return 4; }
async function af() { const x = await Promise.resolve(1); return x; }
async function* ag() { yield await Promise.resolve(1); }
const arrow = async (x) => await x;
