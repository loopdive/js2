const a = (x) => x + 1;
const b = (x, y) => x + y;
const c = x => x * 2;
const d = ({ a, b }) => a + b;
const e = ([first, ...tail]) => first;
const f = (a, b = 10, ...rest) => a + b + rest.length;
const g = () => ({ wrapped: true });
const h = async (x) => { return await x; };
