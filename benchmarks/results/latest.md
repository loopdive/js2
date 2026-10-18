# js2wasm Benchmark Results

Date: 2026-10-18
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.027ms | 0.040ms | 0.038ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.047ms | 0.010ms | 0.021ms | gc-native |
| string/includes | 0.015ms | 0.038ms | 0.011ms | 0.032ms | gc-native |
| string/split | 0.325ms | 3.65ms | 0.378ms | FAILED | js |
| string/replace | 0.077ms | 0.187ms | 0.042ms | FAILED | gc-native |
| string/case-convert | 0.045ms | 0.174ms | 0.004ms | FAILED | gc-native |
| string/substring | 0.081ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.134ms | 0.721ms | 0.141ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 0.267ms | 0.239ms | 0.431ms | gc-native |
| array/push-pop | 1.30ms | 0.470ms | 0.475ms | FAILED | host-call |
| array/sort-i32 | 0.657ms | 0.247ms | 0.235ms | FAILED | gc-native |
| array/map-filter | 0.109ms | 0.053ms | 0.052ms | FAILED | gc-native |
| array/reduce | 1.92ms | 0.481ms | 0.475ms | FAILED | gc-native |
| array/indexOf | 3.46ms | 2.23ms | 2.23ms | FAILED | gc-native |
| array/slice | 0.033ms | 0.014ms | 0.014ms | FAILED | host-call |
| array/reverse | 6.87ms | 3.08ms | 3.08ms | FAILED | host-call |
| array/forEach | 0.075ms | 0.023ms | 0.023ms | FAILED | gc-native |
| array/find | 0.212ms | 0.012ms | 0.013ms | 0.939ms | host-call |
| dom/create-elements | 0.031ms | 0.079ms | — | — | js |
| dom/set-attributes | 0.086ms | 0.182ms | — | — | js |
| dom/read-attributes | 0.047ms | 0.109ms | — | — | js |
| dom/modify-text | 0.023ms | 0.088ms | — | — | js |
| mixed/csv-parse | 0.363ms | 5.89ms | 0.243ms | FAILED | gc-native |
| mixed/text-search | 0.315ms | 1.25ms | 0.227ms | 0.877ms | gc-native |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 0.252ms | js |
| mixed/matrix-multiply | 0.146ms | 0.182ms | 0.181ms | 0.560ms | js |
| mixed/sieve | 1.42ms | 1.82ms | 1.79ms | FAILED | js |

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
| string/concat-short | 10000 | 2.70 | 3.96 | 3.82 | — |
| string/concat-long | 1000 | 3.40 | 4.18 | 2.92 | — |
| string/indexOf | 1000 | 15.23 | 46.67 | 10.25 | 21.20 |
| string/includes | 1000 | 15.06 | 37.69 | 11.04 | 31.99 |
| string/split | 10000 | 32.48 | 365.09 | 37.79 | — |
| string/replace | 1000 | 76.93 | 186.73 | 41.78 | — |
| string/case-convert | 2000 | 22.51 | 86.80 | 2.03 | — |
| string/substring | 10000 | 8.09 | 3.09 | 2.66 | — |
| string/trim | 10000 | 13.42 | 72.11 | 14.12 | — |
| string/startsWith-endsWith | 20000 | 16.01 | 13.36 | 11.96 | 21.55 |
| array/map-filter | 30000 | 3.62 | 1.75 | 1.75 | — |
| array/indexOf | 1000 | 3460.25 | 2230.90 | 2227.19 | — |
| dom/create-elements | 2000 | 15.33 | 39.70 | — | — |
| dom/set-attributes | 6000 | 14.26 | 30.41 | — | — |
| dom/read-attributes | 3000 | 15.81 | 36.22 | — | — |
| dom/modify-text | 2000 | 11.53 | 44.15 | — | — |
| mixed/csv-parse | 11000 | 33.01 | 535.83 | 22.11 | — |
| mixed/text-search | 40000 | 7.88 | 31.15 | 5.67 | 21.93 |
| mixed/fibonacci | 10000 | 9.72 | 25.40 | 25.39 | 25.24 |
| mixed/matrix-multiply | 125000 | 1.17 | 1.45 | 1.45 | 4.48 |
| mixed/sieve | 200000 | 7.10 | 9.09 | 8.96 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.47x slower | 1.41x slower | — |
| string/concat-long | 1.23x slower | 1.17x faster | — |
| string/indexOf | 3.06x slower | 1.49x faster | 1.39x slower |
| string/includes | 2.50x slower | 1.36x faster | 2.12x slower |
| string/split | 11.24x slower | 1.16x slower | — |
| string/replace | 2.43x slower | 1.84x faster | — |
| string/case-convert | 3.86x slower | 11.11x faster | — |
| string/substring | 2.62x faster | 3.04x faster | — |
| string/trim | 5.37x slower | 1.05x slower | — |
| string/startsWith-endsWith | 1.20x faster | 1.34x faster | 1.35x slower |
| array/push-pop | 2.77x faster | 2.74x faster | — |
| array/sort-i32 | 2.66x faster | 2.79x faster | — |
| array/map-filter | 2.06x faster | 2.07x faster | — |
| array/reduce | 3.99x faster | 4.03x faster | — |
| array/indexOf | 1.55x faster | 1.55x faster | — |
| array/slice | 2.28x faster | 2.27x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 3.31x faster | 3.31x faster | — |
| array/find | 17.72x faster | 16.71x faster | 4.42x slower |
| dom/create-elements | 2.59x slower | — | — |
| dom/set-attributes | 2.13x slower | — | — |
| dom/read-attributes | 2.29x slower | — | — |
| dom/modify-text | 3.83x slower | — | — |
| mixed/csv-parse | 16.23x slower | 1.49x faster | — |
| mixed/text-search | 3.95x slower | 1.39x faster | 2.78x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.60x slower |
| mixed/matrix-multiply | 1.24x slower | 1.24x slower | 3.84x slower |
| mixed/sieve | 1.28x slower | 1.26x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.04x faster |
| string/concat-long | 1.43x faster |
| string/indexOf | 4.55x faster |
| string/includes | 3.41x faster |
| string/split | 9.66x faster |
| string/replace | 4.47x faster |
| string/case-convert | 42.86x faster |
| string/substring | 1.16x faster |
| string/trim | 5.11x faster |
| string/startsWith-endsWith | 1.12x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.05x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.06x slower |
| mixed/csv-parse | 24.23x faster |
| mixed/text-search | 5.49x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.01x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 980B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.2KB | 10.4KB |
| string/split | 1.9KB | 3.4KB | — |
| string/replace | 1.9KB | 4.4KB | — |
| string/case-convert | 1.8KB | 2.5KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.6KB | 3.0KB | — |
| string/startsWith-endsWith | 2.0KB | 3.9KB | 1.7KB |
| array/push-pop | 1.2KB | 1.6KB | — |
| array/sort-i32 | 3.3KB | 3.8KB | — |
| array/map-filter | 4.3KB | 4.9KB | — |
| array/reduce | 3.0KB | 3.5KB | — |
| array/indexOf | 2.1KB | 2.5KB | — |
| array/slice | 1.3KB | 1.7KB | — |
| array/reverse | 1.2KB | 1.7KB | — |
| array/forEach | 3.4KB | 4.0KB | — |
| array/find | 1.2KB | 1.6KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.6KB | 4.4KB | — |
| mixed/text-search | 2.2KB | 4.3KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 2.8KB | 3.0KB | 991B |
| mixed/sieve | 2.5KB | 2.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 872.9ms | 461.8ms | — |
| string/concat-long | 341.7ms | 499.5ms | — |
| string/indexOf | 292.0ms | 511.1ms | 427.0ms |
| string/includes | 285.4ms | 514.1ms | 406.8ms |
| string/split | 398.4ms | 521.1ms | — |
| string/replace | 382.0ms | 586.6ms | — |
| string/case-convert | 396.4ms | 474.9ms | — |
| string/substring | 307.8ms | 362.2ms | — |
| string/trim | 370.8ms | 524.9ms | — |
| string/startsWith-endsWith | 397.0ms | 527.1ms | 463.7ms |
| array/push-pop | 404.4ms | 450.5ms | — |
| array/sort-i32 | 520.4ms | 555.6ms | — |
| array/map-filter | 539.6ms | 589.3ms | — |
| array/reduce | 471.0ms | 532.7ms | — |
| array/indexOf | 451.7ms | 493.2ms | — |
| array/slice | 396.8ms | 470.1ms | — |
| array/reverse | 402.8ms | 443.4ms | — |
| array/forEach | 491.1ms | 522.8ms | — |
| array/find | 380.2ms | 449.0ms | 411.2ms |
| dom/create-elements | 332.1ms | — | — |
| dom/set-attributes | 297.7ms | — | — |
| dom/read-attributes | 313.7ms | — | — |
| dom/modify-text | 296.1ms | — | — |
| mixed/csv-parse | 400.0ms | 526.1ms | — |
| mixed/text-search | 396.1ms | 527.6ms | 480.3ms |
| mixed/fibonacci | 361.6ms | 368.4ms | 364.3ms |
| mixed/matrix-multiply | 501.6ms | 528.1ms | 406.0ms |
| mixed/sieve | 471.3ms | 462.4ms | — |
