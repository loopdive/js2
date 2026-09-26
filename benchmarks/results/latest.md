# js2wasm Benchmark Results

Date: 2026-09-22
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.060ms | 0.060ms | 0.073ms | FAILED | js |
| string/concat-long | 0.006ms | 0.006ms | 0.007ms | FAILED | js |
| string/indexOf | 0.017ms | 0.052ms | 0.012ms | 0.029ms | gc-native |
| string/includes | 0.016ms | 0.100ms | 0.014ms | 0.041ms | gc-native |
| string/split | 0.365ms | 6.99ms | 2.58ms | FAILED | js |
| string/replace | 0.100ms | 0.534ms | 0.294ms | FAILED | js |
| string/case-convert | 0.051ms | 0.517ms | 0.233ms | FAILED | js |
| string/substring | 0.109ms | 0.038ms | 0.033ms | FAILED | gc-native |
| string/trim | 0.165ms | 3.39ms | 2.45ms | FAILED | js |
| string/startsWith-endsWith | 0.481ms | 2.62ms | 2.62ms | 0.566ms | js |
| array/push-pop | 1.55ms | 0.503ms | 0.503ms | FAILED | host-call |
| array/sort-i32 | 0.651ms | 0.341ms | 0.343ms | FAILED | host-call |
| array/map-filter | 0.151ms | 0.084ms | 0.084ms | FAILED | host-call |
| array/reduce | 2.21ms | 0.497ms | 0.498ms | FAILED | host-call |
| array/indexOf | 5.39ms | 2.66ms | 2.66ms | FAILED | host-call |
| array/slice | 0.049ms | 0.046ms | 0.045ms | FAILED | gc-native |
| array/reverse | 8.45ms | 3.81ms | 3.82ms | FAILED | host-call |
| array/forEach | 0.062ms | 0.026ms | 0.026ms | FAILED | gc-native |
| array/find | 0.294ms | 0.017ms | 0.017ms | 0.981ms | host-call |
| dom/create-elements | 0.071ms | 0.103ms | — | — | js |
| dom/set-attributes | 0.135ms | 0.193ms | — | — | js |
| dom/read-attributes | 0.076ms | 0.120ms | — | — | js |
| dom/modify-text | 0.065ms | 0.105ms | — | — | js |
| mixed/csv-parse | 0.429ms | 7.10ms | 0.603ms | FAILED | js |
| mixed/text-search | 0.442ms | 4.13ms | 2.58ms | 1.18ms | js |
| mixed/fibonacci | 0.137ms | 0.217ms | 0.217ms | 0.216ms | js |
| mixed/matrix-multiply | 0.190ms | 62.69ms | 62.72ms | 0.730ms | js |
| mixed/sieve | 1.72ms | 2.47ms | 2.48ms | FAILED | js |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | warmup | memory access out of bounds |
| string/split | linear-memory | mid-loop | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 5.96 | 5.99 | 7.33 | — |
| string/concat-long | 1000 | 5.82 | 5.99 | 7.05 | — |
| string/indexOf | 1000 | 16.59 | 52.34 | 11.61 | 29.44 |
| string/includes | 1000 | 16.44 | 99.54 | 14.41 | 40.53 |
| string/split | 10000 | 36.52 | 699.01 | 257.61 | — |
| string/replace | 1000 | 99.69 | 534.06 | 294.34 | — |
| string/case-convert | 2000 | 25.68 | 258.34 | 116.29 | — |
| string/substring | 10000 | 10.92 | 3.81 | 3.25 | — |
| string/trim | 10000 | 16.49 | 338.54 | 244.76 | — |
| string/startsWith-endsWith | 20000 | 24.06 | 130.82 | 131.25 | 28.29 |
| array/map-filter | 30000 | 5.05 | 2.79 | 2.79 | — |
| array/indexOf | 1000 | 5393.41 | 2661.75 | 2662.18 | — |
| dom/create-elements | 2000 | 35.39 | 51.57 | — | — |
| dom/set-attributes | 6000 | 22.44 | 32.23 | — | — |
| dom/read-attributes | 3000 | 25.19 | 40.03 | — | — |
| dom/modify-text | 2000 | 32.60 | 52.65 | — | — |
| mixed/csv-parse | 11000 | 39.01 | 645.69 | 54.86 | — |
| mixed/text-search | 40000 | 11.06 | 103.35 | 64.56 | 29.38 |
| mixed/fibonacci | 10000 | 13.66 | 21.67 | 21.73 | 21.56 |
| mixed/matrix-multiply | 125000 | 1.52 | 501.54 | 501.78 | 5.84 |
| mixed/sieve | 200000 | 8.58 | 12.35 | 12.39 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.01x slower | 1.23x slower | — |
| string/concat-long | 1.03x slower | 1.21x slower | — |
| string/indexOf | 3.16x slower | 1.43x faster | 1.78x slower |
| string/includes | 6.05x slower | 1.14x faster | 2.46x slower |
| string/split | 19.14x slower | 7.05x slower | — |
| string/replace | 5.36x slower | 2.95x slower | — |
| string/case-convert | 10.06x slower | 4.53x slower | — |
| string/substring | 2.87x faster | 3.36x faster | — |
| string/trim | 20.53x slower | 14.85x slower | — |
| string/startsWith-endsWith | 5.44x slower | 5.46x slower | 1.18x slower |
| array/push-pop | 3.09x faster | 3.09x faster | — |
| array/sort-i32 | 1.91x faster | 1.90x faster | — |
| array/map-filter | 1.81x faster | 1.81x faster | — |
| array/reduce | 4.46x faster | 4.45x faster | — |
| array/indexOf | 2.03x faster | 2.03x faster | — |
| array/slice | 1.06x faster | 1.08x faster | — |
| array/reverse | 2.22x faster | 2.21x faster | — |
| array/forEach | 2.40x faster | 2.41x faster | — |
| array/find | 17.14x faster | 17.12x faster | 3.34x slower |
| dom/create-elements | 1.46x slower | — | — |
| dom/set-attributes | 1.44x slower | — | — |
| dom/read-attributes | 1.59x slower | — | — |
| dom/modify-text | 1.62x slower | — | — |
| mixed/csv-parse | 16.55x slower | 1.41x slower | — |
| mixed/text-search | 9.35x slower | 5.84x slower | 2.66x slower |
| mixed/fibonacci | 1.59x slower | 1.59x slower | 1.58x slower |
| mixed/matrix-multiply | 329.42x slower | 329.58x slower | 3.84x slower |
| mixed/sieve | 1.44x slower | 1.44x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.22x slower |
| string/concat-long | 1.18x slower |
| string/indexOf | 4.51x faster |
| string/includes | 6.91x faster |
| string/split | 2.71x faster |
| string/replace | 1.81x faster |
| string/case-convert | 2.22x faster |
| string/substring | 1.17x faster |
| string/trim | 1.38x faster |
| string/startsWith-endsWith | 1.00x slower |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.02x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.00x slower |
| mixed/csv-parse | 11.77x faster |
| mixed/text-search | 1.60x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.00x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.8KB | 3.5KB | — |
| string/replace | 1.9KB | 4.4KB | — |
| string/case-convert | 1.8KB | 2.5KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.5KB | 3.1KB | — |
| string/startsWith-endsWith | 2.0KB | 4.0KB | 1.7KB |
| array/push-pop | 1.2KB | 1.6KB | — |
| array/sort-i32 | 3.3KB | 3.9KB | — |
| array/map-filter | 4.5KB | 5.0KB | — |
| array/reduce | 3.1KB | 3.6KB | — |
| array/indexOf | 2.1KB | 2.5KB | — |
| array/slice | 1.3KB | 1.7KB | — |
| array/reverse | 1.2KB | 1.7KB | — |
| array/forEach | 3.5KB | 4.1KB | — |
| array/find | 1.2KB | 1.6KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.5KB | 4.5KB | — |
| mixed/text-search | 2.2KB | 4.3KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 3.0KB | 3.6KB | 991B |
| mixed/sieve | 2.0KB | 2.4KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1132.8ms | 661.8ms | — |
| string/concat-long | 463.0ms | 709.8ms | — |
| string/indexOf | 403.0ms | 682.3ms | 584.1ms |
| string/includes | 394.6ms | 723.7ms | 595.9ms |
| string/split | 546.8ms | 743.9ms | — |
| string/replace | 544.6ms | 800.9ms | — |
| string/case-convert | 540.4ms | 673.2ms | — |
| string/substring | 407.4ms | 509.7ms | — |
| string/trim | 508.5ms | 696.1ms | — |
| string/startsWith-endsWith | 516.4ms | 734.7ms | 659.4ms |
| array/push-pop | 559.3ms | 619.6ms | — |
| array/sort-i32 | 678.6ms | 762.6ms | — |
| array/map-filter | 738.8ms | 781.0ms | — |
| array/reduce | 634.1ms | 729.6ms | — |
| array/indexOf | 604.8ms | 711.4ms | — |
| array/slice | 534.6ms | 634.7ms | — |
| array/reverse | 547.7ms | 594.0ms | — |
| array/forEach | 667.8ms | 748.3ms | — |
| array/find | 509.6ms | 610.2ms | 574.3ms |
| dom/create-elements | 435.4ms | — | — |
| dom/set-attributes | 407.1ms | — | — |
| dom/read-attributes | 410.9ms | — | — |
| dom/modify-text | 395.3ms | — | — |
| mixed/csv-parse | 537.3ms | 715.4ms | — |
| mixed/text-search | 521.1ms | 744.3ms | 675.2ms |
| mixed/fibonacci | 469.3ms | 511.7ms | 480.7ms |
| mixed/matrix-multiply | 650.1ms | 740.4ms | 535.8ms |
| mixed/sieve | 608.9ms | 640.5ms | — |
