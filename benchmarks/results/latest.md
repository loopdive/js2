# js2wasm Benchmark Results

Date: 2026-09-26
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.030ms | 0.041ms | 0.040ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.047ms | 0.010ms | 0.019ms | gc-native |
| string/includes | 0.015ms | 0.079ms | 0.011ms | 0.025ms | gc-native |
| string/split | 0.327ms | 6.05ms | 2.09ms | FAILED | js |
| string/replace | 0.075ms | 0.470ms | 0.217ms | FAILED | js |
| string/case-convert | 0.045ms | 0.425ms | 0.194ms | FAILED | js |
| string/substring | 0.081ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.134ms | 2.52ms | 1.95ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 2.03ms | 1.98ms | 0.432ms | js |
| array/push-pop | 1.30ms | 0.473ms | 0.475ms | FAILED | host-call |
| array/sort-i32 | 0.658ms | 0.239ms | 0.235ms | FAILED | gc-native |
| array/map-filter | 0.108ms | 0.053ms | 0.052ms | FAILED | gc-native |
| array/reduce | 1.28ms | 0.478ms | 0.472ms | FAILED | gc-native |
| array/indexOf | 3.46ms | 2.22ms | 2.22ms | FAILED | gc-native |
| array/slice | 0.032ms | 0.015ms | 0.014ms | FAILED | gc-native |
| array/reverse | 6.86ms | 3.08ms | 3.08ms | FAILED | host-call |
| array/forEach | 0.044ms | 0.023ms | 0.023ms | FAILED | gc-native |
| array/find | 0.213ms | 0.012ms | 0.012ms | 0.869ms | host-call |
| dom/create-elements | 0.186ms | 0.082ms | — | — | host-call |
| dom/set-attributes | 0.089ms | 0.184ms | — | — | js |
| dom/read-attributes | 0.050ms | 0.104ms | — | — | js |
| dom/modify-text | 0.026ms | 0.088ms | — | — | js |
| mixed/csv-parse | 0.848ms | 6.53ms | 0.432ms | FAILED | gc-native |
| mixed/text-search | 0.312ms | 3.24ms | 1.92ms | 0.870ms | js |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 0.253ms | js |
| mixed/matrix-multiply | 0.147ms | 51.96ms | 52.80ms | 0.604ms | js |
| mixed/sieve | 1.43ms | 1.80ms | 1.80ms | FAILED | js |

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
| string/concat-short | 10000 | 2.99 | 4.06 | 4.00 | — |
| string/concat-long | 1000 | 3.50 | 4.60 | 3.32 | — |
| string/indexOf | 1000 | 14.76 | 46.88 | 9.97 | 19.39 |
| string/includes | 1000 | 14.55 | 79.03 | 11.40 | 24.99 |
| string/split | 10000 | 32.65 | 605.38 | 208.72 | — |
| string/replace | 1000 | 75.25 | 469.66 | 217.10 | — |
| string/case-convert | 2000 | 22.45 | 212.52 | 96.84 | — |
| string/substring | 10000 | 8.10 | 3.09 | 2.66 | — |
| string/trim | 10000 | 13.41 | 252.36 | 195.00 | — |
| string/startsWith-endsWith | 20000 | 16.00 | 101.52 | 99.02 | 21.58 |
| array/map-filter | 30000 | 3.60 | 1.76 | 1.74 | — |
| array/indexOf | 1000 | 3459.51 | 2225.00 | 2220.67 | — |
| dom/create-elements | 2000 | 92.92 | 40.95 | — | — |
| dom/set-attributes | 6000 | 14.89 | 30.73 | — | — |
| dom/read-attributes | 3000 | 16.63 | 34.58 | — | — |
| dom/modify-text | 2000 | 13.17 | 43.89 | — | — |
| mixed/csv-parse | 11000 | 77.11 | 593.30 | 39.26 | — |
| mixed/text-search | 40000 | 7.81 | 81.03 | 48.11 | 21.75 |
| mixed/fibonacci | 10000 | 9.71 | 25.39 | 25.40 | 25.25 |
| mixed/matrix-multiply | 125000 | 1.18 | 415.72 | 422.37 | 4.83 |
| mixed/sieve | 200000 | 7.16 | 9.01 | 9.00 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.36x slower | 1.34x slower | — |
| string/concat-long | 1.31x slower | 1.05x faster | — |
| string/indexOf | 3.18x slower | 1.48x faster | 1.31x slower |
| string/includes | 5.43x slower | 1.28x faster | 1.72x slower |
| string/split | 18.54x slower | 6.39x slower | — |
| string/replace | 6.24x slower | 2.88x slower | — |
| string/case-convert | 9.47x slower | 4.31x slower | — |
| string/substring | 2.62x faster | 3.05x faster | — |
| string/trim | 18.82x slower | 14.54x slower | — |
| string/startsWith-endsWith | 6.35x slower | 6.19x slower | 1.35x slower |
| array/push-pop | 2.74x faster | 2.73x faster | — |
| array/sort-i32 | 2.76x faster | 2.80x faster | — |
| array/map-filter | 2.05x faster | 2.07x faster | — |
| array/reduce | 2.68x faster | 2.72x faster | — |
| array/indexOf | 1.55x faster | 1.56x faster | — |
| array/slice | 2.20x faster | 2.22x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.92x faster | 1.92x faster | — |
| array/find | 17.80x faster | 17.64x faster | 4.07x slower |
| dom/create-elements | 2.27x faster | — | — |
| dom/set-attributes | 2.06x slower | — | — |
| dom/read-attributes | 2.08x slower | — | — |
| dom/modify-text | 3.33x slower | — | — |
| mixed/csv-parse | 7.69x slower | 1.96x faster | — |
| mixed/text-search | 10.38x slower | 6.16x slower | 2.79x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.60x slower |
| mixed/matrix-multiply | 353.78x slower | 359.45x slower | 4.11x slower |
| mixed/sieve | 1.26x slower | 1.26x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.01x faster |
| string/concat-long | 1.39x faster |
| string/indexOf | 4.70x faster |
| string/includes | 6.94x faster |
| string/split | 2.90x faster |
| string/replace | 2.16x faster |
| string/case-convert | 2.19x faster |
| string/substring | 1.16x faster |
| string/trim | 1.29x faster |
| string/startsWith-endsWith | 1.03x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.01x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 15.11x faster |
| mixed/text-search | 1.68x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.02x slower |
| mixed/sieve | 1.00x faster |

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
| array/sort-i32 | 3.3KB | 3.8KB | — |
| array/map-filter | 4.3KB | 4.8KB | — |
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
| mixed/csv-parse | 2.5KB | 4.5KB | — |
| mixed/text-search | 2.2KB | 4.3KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 3.0KB | 3.6KB | 991B |
| mixed/sieve | 2.0KB | 2.4KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 957.8ms | 523.9ms | — |
| string/concat-long | 363.2ms | 531.0ms | — |
| string/indexOf | 318.0ms | 547.0ms | 451.5ms |
| string/includes | 307.4ms | 540.2ms | 441.1ms |
| string/split | 403.0ms | 567.4ms | — |
| string/replace | 396.2ms | 584.6ms | — |
| string/case-convert | 406.3ms | 479.5ms | — |
| string/substring | 303.8ms | 373.4ms | — |
| string/trim | 380.0ms | 531.2ms | — |
| string/startsWith-endsWith | 375.3ms | 539.7ms | 479.1ms |
| array/push-pop | 397.9ms | 471.8ms | — |
| array/sort-i32 | 504.8ms | 576.6ms | — |
| array/map-filter | 506.0ms | 555.3ms | — |
| array/reduce | 472.1ms | 520.1ms | — |
| array/indexOf | 461.5ms | 527.6ms | — |
| array/slice | 393.1ms | 467.7ms | — |
| array/reverse | 390.7ms | 452.3ms | — |
| array/forEach | 496.7ms | 537.4ms | — |
| array/find | 381.3ms | 458.8ms | 409.2ms |
| dom/create-elements | 326.9ms | — | — |
| dom/set-attributes | 315.1ms | — | — |
| dom/read-attributes | 311.3ms | — | — |
| dom/modify-text | 304.3ms | — | — |
| mixed/csv-parse | 394.9ms | 520.0ms | — |
| mixed/text-search | 391.4ms | 549.7ms | 468.9ms |
| mixed/fibonacci | 349.2ms | 366.5ms | 356.3ms |
| mixed/matrix-multiply | 485.6ms | 534.2ms | 395.8ms |
| mixed/sieve | 463.0ms | 515.5ms | — |
