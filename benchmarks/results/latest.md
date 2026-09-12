# js2wasm Benchmark Results

Date: 2026-09-12
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.036ms | 0.054ms | 0.049ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.129ms | 0.014ms | 0.017ms | gc-native |
| string/split | 0.424ms | 7.82ms | 2.60ms | FAILED | js |
| string/replace | 0.094ms | 0.571ms | 0.276ms | FAILED | js |
| string/case-convert | 0.058ms | 0.544ms | 0.244ms | FAILED | js |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.177ms | 3.36ms | 2.40ms | FAILED | js |
| string/startsWith-endsWith | 0.412ms | 2.55ms | 2.52ms | 0.558ms | js |
| array/push-pop | 1.65ms | 0.602ms | 0.589ms | FAILED | gc-native |
| array/sort-i32 | 0.849ms | 0.302ms | 0.301ms | FAILED | gc-native |
| array/map-filter | 0.080ms | 0.066ms | 0.066ms | FAILED | host-call |
| array/reduce | 2.39ms | 0.600ms | 0.598ms | FAILED | gc-native |
| array/indexOf | 4.47ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.033ms | 0.017ms | 0.017ms | FAILED | gc-native |
| array/reverse | 8.85ms | 3.97ms | 3.97ms | FAILED | host-call |
| array/forEach | 0.052ms | 0.029ms | 0.029ms | FAILED | host-call |
| array/find | 0.294ms | 0.015ms | 0.015ms | 1.21ms | gc-native |
| dom/create-elements | 0.038ms | 0.155ms | — | — | js |
| dom/set-attributes | 0.107ms | 0.235ms | — | — | js |
| dom/read-attributes | 0.059ms | 0.134ms | — | — | js |
| dom/modify-text | 0.029ms | 0.111ms | — | — | js |
| mixed/csv-parse | 0.471ms | 8.04ms | 0.535ms | FAILED | js |
| mixed/text-search | 0.403ms | 4.09ms | 2.40ms | 1.14ms | js |
| mixed/fibonacci | 0.125ms | 0.328ms | 0.328ms | 0.325ms | js |
| mixed/matrix-multiply | 0.184ms | 62.81ms | 64.60ms | 0.722ms | js |
| mixed/sieve | 1.77ms | 2.31ms | 2.31ms | FAILED | js |

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
| string/concat-short | 10000 | 3.57 | 5.42 | 4.94 | — |
| string/concat-long | 1000 | 3.96 | 5.33 | 3.35 | — |
| string/indexOf | 1000 | 18.93 | 59.85 | 12.16 | 16.09 |
| string/includes | 1000 | 18.70 | 129.11 | 13.79 | 16.74 |
| string/split | 10000 | 42.36 | 781.87 | 260.23 | — |
| string/replace | 1000 | 93.93 | 571.34 | 276.48 | — |
| string/case-convert | 2000 | 28.99 | 272.15 | 121.96 | — |
| string/substring | 10000 | 10.42 | 3.98 | 3.43 | — |
| string/trim | 10000 | 17.67 | 336.42 | 239.64 | — |
| string/startsWith-endsWith | 20000 | 20.59 | 127.26 | 126.00 | 27.91 |
| array/map-filter | 30000 | 2.67 | 2.19 | 2.19 | — |
| array/indexOf | 1000 | 4469.39 | 2863.52 | 2862.27 | — |
| dom/create-elements | 2000 | 19.16 | 77.53 | — | — |
| dom/set-attributes | 6000 | 17.83 | 39.25 | — | — |
| dom/read-attributes | 3000 | 19.61 | 44.82 | — | — |
| dom/modify-text | 2000 | 14.67 | 55.60 | — | — |
| mixed/csv-parse | 11000 | 42.82 | 731.20 | 48.67 | — |
| mixed/text-search | 40000 | 10.07 | 102.27 | 59.97 | 28.43 |
| mixed/fibonacci | 10000 | 12.53 | 32.76 | 32.76 | 32.50 |
| mixed/matrix-multiply | 125000 | 1.47 | 502.47 | 516.81 | 5.78 |
| mixed/sieve | 200000 | 8.87 | 11.56 | 11.56 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.52x slower | 1.38x slower | — |
| string/concat-long | 1.34x slower | 1.18x faster | — |
| string/indexOf | 3.16x slower | 1.56x faster | 1.18x faster |
| string/includes | 6.90x slower | 1.36x faster | 1.12x faster |
| string/split | 18.46x slower | 6.14x slower | — |
| string/replace | 6.08x slower | 2.94x slower | — |
| string/case-convert | 9.39x slower | 4.21x slower | — |
| string/substring | 2.62x faster | 3.04x faster | — |
| string/trim | 19.04x slower | 13.56x slower | — |
| string/startsWith-endsWith | 6.18x slower | 6.12x slower | 1.36x slower |
| array/push-pop | 2.75x faster | 2.81x faster | — |
| array/sort-i32 | 2.81x faster | 2.83x faster | — |
| array/map-filter | 1.22x faster | 1.22x faster | — |
| array/reduce | 3.98x faster | 3.99x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.00x faster | 2.01x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.83x faster | 1.83x faster | — |
| array/find | 19.60x faster | 19.89x faster | 4.10x slower |
| dom/create-elements | 4.05x slower | — | — |
| dom/set-attributes | 2.20x slower | — | — |
| dom/read-attributes | 2.28x slower | — | — |
| dom/modify-text | 3.79x slower | — | — |
| mixed/csv-parse | 17.08x slower | 1.14x slower | — |
| mixed/text-search | 10.16x slower | 5.96x slower | 2.82x slower |
| mixed/fibonacci | 2.61x slower | 2.62x slower | 2.59x slower |
| mixed/matrix-multiply | 341.34x slower | 351.08x slower | 3.93x slower |
| mixed/sieve | 1.30x slower | 1.30x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.10x faster |
| string/concat-long | 1.59x faster |
| string/indexOf | 4.92x faster |
| string/includes | 9.36x faster |
| string/split | 3.00x faster |
| string/replace | 2.07x faster |
| string/case-convert | 2.23x faster |
| string/substring | 1.16x faster |
| string/trim | 1.40x faster |
| string/startsWith-endsWith | 1.01x faster |
| array/push-pop | 1.02x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 15.02x faster |
| mixed/text-search | 1.71x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.03x slower |
| mixed/sieve | 1.00x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.1KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.7KB | 3.2KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.8KB | 2.1KB | — |
| array/slice | 999B | 1.3KB | — |
| array/reverse | 977B | 1.3KB | — |
| array/forEach | 2.8KB | 3.3KB | — |
| array/find | 946B | 1.3KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 2.6KB | 3.2KB | 991B |
| mixed/sieve | 1.7KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1110.0ms | 627.1ms | — |
| string/concat-long | 445.2ms | 671.1ms | — |
| string/indexOf | 380.8ms | 657.0ms | 555.3ms |
| string/includes | 374.9ms | 677.7ms | 548.6ms |
| string/split | 514.7ms | 660.0ms | — |
| string/replace | 511.5ms | 716.1ms | — |
| string/case-convert | 507.0ms | 590.1ms | — |
| string/substring | 405.3ms | 473.9ms | — |
| string/trim | 519.5ms | 662.9ms | — |
| string/startsWith-endsWith | 466.8ms | 667.9ms | 608.4ms |
| array/push-pop | 481.0ms | 556.3ms | — |
| array/sort-i32 | 630.7ms | 712.2ms | — |
| array/map-filter | 659.3ms | 694.4ms | — |
| array/reduce | 561.7ms | 678.4ms | — |
| array/indexOf | 568.6ms | 680.2ms | — |
| array/slice | 500.6ms | 582.7ms | — |
| array/reverse | 485.6ms | 577.2ms | — |
| array/forEach | 599.6ms | 700.8ms | — |
| array/find | 505.9ms | 592.7ms | 535.0ms |
| dom/create-elements | 421.4ms | — | — |
| dom/set-attributes | 404.7ms | — | — |
| dom/read-attributes | 410.5ms | — | — |
| dom/modify-text | 397.9ms | — | — |
| mixed/csv-parse | 505.2ms | 651.0ms | — |
| mixed/text-search | 483.0ms | 680.6ms | 598.6ms |
| mixed/fibonacci | 468.4ms | 492.7ms | 473.9ms |
| mixed/matrix-multiply | 599.6ms | 686.4ms | 515.9ms |
| mixed/sieve | 551.1ms | 652.6ms | — |
