# js2wasm Benchmark Results

Date: 2026-09-03
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.027ms | 0.042ms | 0.038ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.047ms | 0.010ms | 0.017ms | gc-native |
| string/includes | 0.014ms | 0.079ms | 0.011ms | 0.013ms | gc-native |
| string/split | 0.323ms | 6.00ms | 2.03ms | FAILED | js |
| string/replace | 0.074ms | 0.431ms | 0.212ms | FAILED | js |
| string/case-convert | 0.045ms | 0.409ms | 0.186ms | FAILED | js |
| string/substring | 0.081ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.134ms | 2.64ms | 1.82ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 1.97ms | 1.95ms | 0.432ms | js |
| array/push-pop | 1.32ms | 0.481ms | 0.524ms | FAILED | host-call |
| array/sort-i32 | 0.659ms | 0.236ms | 0.232ms | FAILED | gc-native |
| array/map-filter | 0.108ms | 0.053ms | 0.052ms | FAILED | gc-native |
| array/reduce | 1.86ms | 0.481ms | 0.465ms | FAILED | gc-native |
| array/indexOf | 3.46ms | 2.22ms | 2.22ms | FAILED | gc-native |
| array/slice | 0.031ms | 0.017ms | 0.014ms | FAILED | gc-native |
| array/reverse | 6.86ms | 3.08ms | 3.08ms | FAILED | host-call |
| array/forEach | 0.043ms | 0.023ms | 0.023ms | FAILED | gc-native |
| array/find | 0.213ms | 0.012ms | 0.012ms | 0.940ms | gc-native |
| dom/create-elements | 0.031ms | 0.123ms | — | — | js |
| dom/set-attributes | 0.085ms | 0.426ms | — | — | js |
| dom/read-attributes | 0.050ms | 0.106ms | — | — | js |
| dom/modify-text | 0.023ms | 0.088ms | — | — | js |
| mixed/csv-parse | 0.366ms | 6.44ms | 0.426ms | FAILED | js |
| mixed/text-search | 0.312ms | 3.47ms | 1.87ms | 0.872ms | js |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 0.252ms | js |
| mixed/matrix-multiply | 0.146ms | 50.23ms | 50.62ms | 0.562ms | js |
| mixed/sieve | 1.38ms | 1.80ms | 1.83ms | FAILED | js |

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
| string/concat-short | 10000 | 2.75 | 4.20 | 3.85 | — |
| string/concat-long | 1000 | 3.35 | 4.21 | 2.97 | — |
| string/indexOf | 1000 | 14.74 | 46.54 | 9.80 | 16.88 |
| string/includes | 1000 | 14.50 | 78.85 | 10.98 | 12.90 |
| string/split | 10000 | 32.30 | 599.75 | 203.33 | — |
| string/replace | 1000 | 73.86 | 431.32 | 211.85 | — |
| string/case-convert | 2000 | 22.44 | 204.73 | 93.10 | — |
| string/substring | 10000 | 8.09 | 3.10 | 2.66 | — |
| string/trim | 10000 | 13.41 | 263.56 | 182.48 | — |
| string/startsWith-endsWith | 20000 | 16.00 | 98.46 | 97.52 | 21.58 |
| array/map-filter | 30000 | 3.59 | 1.75 | 1.74 | — |
| array/indexOf | 1000 | 3459.31 | 2221.17 | 2220.92 | — |
| dom/create-elements | 2000 | 15.40 | 61.53 | — | — |
| dom/set-attributes | 6000 | 14.23 | 70.95 | — | — |
| dom/read-attributes | 3000 | 16.54 | 35.20 | — | — |
| dom/modify-text | 2000 | 11.48 | 44.03 | — | — |
| mixed/csv-parse | 11000 | 33.23 | 585.70 | 38.69 | — |
| mixed/text-search | 40000 | 7.81 | 86.78 | 46.82 | 21.81 |
| mixed/fibonacci | 10000 | 9.72 | 25.41 | 25.40 | 25.24 |
| mixed/matrix-multiply | 125000 | 1.17 | 401.85 | 404.96 | 4.50 |
| mixed/sieve | 200000 | 6.91 | 9.00 | 9.15 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.53x slower | 1.40x slower | — |
| string/concat-long | 1.26x slower | 1.13x faster | — |
| string/indexOf | 3.16x slower | 1.50x faster | 1.15x slower |
| string/includes | 5.44x slower | 1.32x faster | 1.12x faster |
| string/split | 18.57x slower | 6.30x slower | — |
| string/replace | 5.84x slower | 2.87x slower | — |
| string/case-convert | 9.12x slower | 4.15x slower | — |
| string/substring | 2.61x faster | 3.04x faster | — |
| string/trim | 19.65x slower | 13.60x slower | — |
| string/startsWith-endsWith | 6.15x slower | 6.10x slower | 1.35x slower |
| array/push-pop | 2.75x faster | 2.52x faster | — |
| array/sort-i32 | 2.80x faster | 2.85x faster | — |
| array/map-filter | 2.05x faster | 2.06x faster | — |
| array/reduce | 3.87x faster | 4.00x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 1.76x faster | 2.20x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.88x faster | 1.88x faster | — |
| array/find | 17.56x faster | 17.72x faster | 4.42x slower |
| dom/create-elements | 3.99x slower | — | — |
| dom/set-attributes | 4.99x slower | — | — |
| dom/read-attributes | 2.13x slower | — | — |
| dom/modify-text | 3.84x slower | — | — |
| mixed/csv-parse | 17.62x slower | 1.16x slower | — |
| mixed/text-search | 11.11x slower | 6.00x slower | 2.79x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.60x slower |
| mixed/matrix-multiply | 343.17x slower | 345.83x slower | 3.84x slower |
| mixed/sieve | 1.30x slower | 1.32x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.09x faster |
| string/concat-long | 1.42x faster |
| string/indexOf | 4.75x faster |
| string/includes | 7.18x faster |
| string/split | 2.95x faster |
| string/replace | 2.04x faster |
| string/case-convert | 2.20x faster |
| string/substring | 1.16x faster |
| string/trim | 1.44x faster |
| string/startsWith-endsWith | 1.01x faster |
| array/push-pop | 1.09x slower |
| array/sort-i32 | 1.02x faster |
| array/map-filter | 1.01x faster |
| array/reduce | 1.03x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.25x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 15.14x faster |
| mixed/text-search | 1.85x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.01x slower |
| mixed/sieve | 1.02x slower |

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
| array/sort-i32 | 2.8KB | 3.3KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.8KB | 2.1KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.8KB | 3.4KB | — |
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
| string/concat-short | 1321.8ms | 807.6ms | — |
| string/concat-long | 603.2ms | 731.8ms | — |
| string/indexOf | 514.4ms | 743.8ms | 668.7ms |
| string/includes | 502.2ms | 747.6ms | 658.4ms |
| string/split | 606.9ms | 752.0ms | — |
| string/replace | 588.0ms | 806.6ms | — |
| string/case-convert | 609.2ms | 675.7ms | — |
| string/substring | 523.2ms | 607.3ms | — |
| string/trim | 598.7ms | 737.8ms | — |
| string/startsWith-endsWith | 588.1ms | 773.0ms | 715.0ms |
| array/push-pop | 602.8ms | 681.7ms | — |
| array/sort-i32 | 715.7ms | 764.4ms | — |
| array/map-filter | 738.8ms | 799.1ms | — |
| array/reduce | 670.2ms | 757.6ms | — |
| array/indexOf | 671.8ms | 731.8ms | — |
| array/slice | 627.5ms | 684.7ms | — |
| array/reverse | 601.9ms | 675.8ms | — |
| array/forEach | 679.9ms | 757.6ms | — |
| array/find | 603.2ms | 666.4ms | 648.3ms |
| dom/create-elements | 555.4ms | — | — |
| dom/set-attributes | 582.6ms | — | — |
| dom/read-attributes | 557.0ms | — | — |
| dom/modify-text | 554.8ms | — | — |
| mixed/csv-parse | 623.2ms | 752.8ms | — |
| mixed/text-search | 592.8ms | 743.7ms | 688.7ms |
| mixed/fibonacci | 589.1ms | 609.0ms | 578.9ms |
| mixed/matrix-multiply | 696.3ms | 734.5ms | 628.8ms |
| mixed/sieve | 674.0ms | 738.5ms | — |
