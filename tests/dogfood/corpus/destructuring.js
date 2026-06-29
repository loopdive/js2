const [a, b, ...rest] = [1, 2, 3, 4];
const { x, y: yy, z = 10, ...others } = obj;
const [[m], { n }] = pairs;
function f({ p = 1, q: { r } }, [s, ...t]) { return p + r + s; }
[a, b] = [b, a];
({ x, y } = point);
