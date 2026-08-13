# js2wasm Benchmark Results

Date: 2026-08-13
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.038ms | 0.037ms | 0.041ms | FAILED | host-call |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.012ms | 0.041ms | 0.009ms | 0.028ms | gc-native |
| string/includes | 0.013ms | 0.076ms | 0.010ms | 0.015ms | gc-native |
| string/split | 0.258ms | 2.88ms | 0.300ms | FAILED | js |
| string/replace | 0.060ms | 0.168ms | 0.045ms | FAILED | gc-native |
| string/case-convert | 0.036ms | 0.124ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.101ms | 0.027ms | 0.023ms | FAILED | gc-native |
| string/trim | 0.169ms | 0.608ms | 0.138ms | FAILED | gc-native |
| string/startsWith-endsWith | 0.408ms | 0.266ms | 0.188ms | 0.392ms | gc-native |
| array/push-pop | 1.06ms | 0.313ms | 0.383ms | FAILED | host-call |
| array/sort-i32 | 0.457ms | 0.248ms | 0.248ms | FAILED | gc-native |
| array/map-filter | 0.093ms | 0.058ms | 0.056ms | FAILED | gc-native |
| array/reduce | 1.54ms | 0.351ms | 0.310ms | FAILED | gc-native |
| array/indexOf | 3.91ms | 1.87ms | 1.87ms | FAILED | host-call |
| array/slice | 0.024ms | 0.024ms | 0.024ms | FAILED | host-call |
| array/reverse | 4.96ms | 2.72ms | 2.73ms | FAILED | host-call |
| array/forEach | 0.047ms | 0.018ms | 0.020ms | FAILED | host-call |
| array/find | 0.240ms | 0.013ms | 0.011ms | 0.715ms | gc-native |
| dom/create-elements | 0.064ms | 0.131ms | — | — | js |
| dom/set-attributes | 0.092ms | 0.348ms | — | — | js |
| dom/read-attributes | 0.052ms | 0.082ms | — | — | js |
| dom/modify-text | 0.040ms | 0.084ms | — | — | js |
| mixed/csv-parse | 0.903ms | 4.92ms | 0.210ms | FAILED | gc-native |
| mixed/text-search | 0.304ms | 0.894ms | 0.186ms | 0.813ms | gc-native |
| mixed/fibonacci | 0.098ms | 0.153ms | 0.153ms | 0.154ms | js |
| mixed/matrix-multiply | 0.143ms | 0.167ms | 0.166ms | 0.524ms | js |
| mixed/sieve | 1.29ms | 1.17ms | 1.18ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.83 | 3.68 | 4.13 | — |
| string/concat-long | 1000 | 3.52 | 3.87 | 4.10 | — |
| string/indexOf | 1000 | 11.74 | 41.48 | 9.41 | 28.16 |
| string/includes | 1000 | 13.30 | 75.51 | 10.09 | 14.70 |
| string/split | 10000 | 25.84 | 287.88 | 30.00 | — |
| string/replace | 1000 | 60.39 | 168.24 | 45.24 | — |
| string/case-convert | 2000 | 18.03 | 62.21 | 2.26 | — |
| string/substring | 10000 | 10.12 | 2.73 | 2.30 | — |
| string/trim | 10000 | 16.86 | 60.82 | 13.80 | — |
| string/startsWith-endsWith | 20000 | 20.38 | 13.28 | 9.41 | 19.60 |
| array/map-filter | 30000 | 3.10 | 1.92 | 1.87 | — |
| array/indexOf | 1000 | 3908.61 | 1871.69 | 1872.74 | — |
| dom/create-elements | 2000 | 32.17 | 65.27 | — | — |
| dom/set-attributes | 6000 | 15.30 | 57.92 | — | — |
| dom/read-attributes | 3000 | 17.20 | 27.33 | — | — |
| dom/modify-text | 2000 | 20.21 | 42.12 | — | — |
| mixed/csv-parse | 11000 | 82.07 | 447.29 | 19.05 | — |
| mixed/text-search | 40000 | 7.61 | 22.36 | 4.65 | 20.32 |
| mixed/fibonacci | 10000 | 9.84 | 15.27 | 15.28 | 15.37 |
| mixed/matrix-multiply | 125000 | 1.15 | 1.34 | 1.33 | 4.19 |
| mixed/sieve | 200000 | 6.46 | 5.85 | 5.88 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.04x faster | 1.08x slower | — |
| string/concat-long | 1.10x slower | 1.16x slower | — |
| string/indexOf | 3.53x slower | 1.25x faster | 2.40x slower |
| string/includes | 5.68x slower | 1.32x faster | 1.11x slower |
| string/split | 11.14x slower | 1.16x slower | — |
| string/replace | 2.79x slower | 1.33x faster | — |
| string/case-convert | 3.45x slower | 7.98x faster | — |
| string/substring | 3.70x faster | 4.39x faster | — |
| string/trim | 3.61x slower | 1.22x faster | — |
| string/startsWith-endsWith | 1.53x faster | 2.17x faster | 1.04x faster |
| array/push-pop | 3.37x faster | 2.75x faster | — |
| array/sort-i32 | 1.84x faster | 1.85x faster | — |
| array/map-filter | 1.61x faster | 1.66x faster | — |
| array/reduce | 4.39x faster | 4.95x faster | — |
| array/indexOf | 2.09x faster | 2.09x faster | — |
| array/slice | 1.03x faster | 1.00x faster | — |
| array/reverse | 1.82x faster | 1.82x faster | — |
| array/forEach | 2.59x faster | 2.38x faster | — |
| array/find | 18.85x faster | 21.77x faster | 2.98x slower |
| dom/create-elements | 2.03x slower | — | — |
| dom/set-attributes | 3.79x slower | — | — |
| dom/read-attributes | 1.59x slower | — | — |
| dom/modify-text | 2.08x slower | — | — |
| mixed/csv-parse | 5.45x slower | 4.31x faster | — |
| mixed/text-search | 2.94x slower | 1.64x faster | 2.67x slower |
| mixed/fibonacci | 1.55x slower | 1.55x slower | 1.56x slower |
| mixed/matrix-multiply | 1.17x slower | 1.16x slower | 3.65x slower |
| mixed/sieve | 1.10x faster | 1.10x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.12x slower |
| string/concat-long | 1.06x slower |
| string/indexOf | 4.41x faster |
| string/includes | 7.48x faster |
| string/split | 9.60x faster |
| string/replace | 3.72x faster |
| string/case-convert | 27.52x faster |
| string/substring | 1.19x faster |
| string/trim | 4.41x faster |
| string/startsWith-endsWith | 1.41x faster |
| array/push-pop | 1.22x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.03x faster |
| array/reduce | 1.13x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.03x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.09x slower |
| array/find | 1.15x faster |
| mixed/csv-parse | 23.48x faster |
| mixed/text-search | 4.81x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.01x faster |
| mixed/sieve | 1.00x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 736B | — |
| string/concat-long | 223B | 940B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.0KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.5KB | 2.1KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.6KB | — |
| string/startsWith-endsWith | 1.7KB | 3.5KB | 1.7KB |
| array/push-pop | 914B | 1.2KB | — |
| array/sort-i32 | 2.5KB | 2.9KB | — |
| array/map-filter | 3.3KB | 3.6KB | — |
| array/reduce | 2.3KB | 2.6KB | — |
| array/indexOf | 1.6KB | 2.0KB | — |
| array/slice | 994B | 1.3KB | — |
| array/reverse | 972B | 1.3KB | — |
| array/forEach | 2.5KB | 2.8KB | — |
| array/find | 920B | 1.2KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.0KB | — |
| mixed/text-search | 1.9KB | 3.9KB | 1.9KB |
| mixed/fibonacci | 405B | 405B | 386B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 992B |
| mixed/sieve | 1.5KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 888.6ms | 805.4ms | — |
| string/concat-long | 439.3ms | 688.0ms | — |
| string/indexOf | 467.7ms | 734.5ms | 649.2ms |
| string/includes | 503.9ms | 682.1ms | 575.5ms |
| string/split | 538.6ms | 658.2ms | — |
| string/replace | 535.9ms | 737.3ms | — |
| string/case-convert | 530.9ms | 580.0ms | — |
| string/substring | 453.3ms | 507.9ms | — |
| string/trim | 504.0ms | 706.5ms | — |
| string/startsWith-endsWith | 585.3ms | 691.7ms | 653.2ms |
| array/push-pop | 539.1ms | 578.5ms | — |
| array/sort-i32 | 622.7ms | 666.3ms | — |
| array/map-filter | 642.4ms | 708.1ms | — |
| array/reduce | 568.3ms | 623.7ms | — |
| array/indexOf | 585.4ms | 621.1ms | — |
| array/slice | 532.5ms | 578.3ms | — |
| array/reverse | 530.8ms | 569.3ms | — |
| array/forEach | 653.0ms | 728.2ms | — |
| array/find | 571.2ms | 573.5ms | 554.7ms |
| dom/create-elements | 464.5ms | — | — |
| dom/set-attributes | 519.1ms | — | — |
| dom/read-attributes | 508.1ms | — | — |
| dom/modify-text | 498.0ms | — | — |
| mixed/csv-parse | 604.7ms | 707.1ms | — |
| mixed/text-search | 546.2ms | 717.6ms | 610.9ms |
| mixed/fibonacci | 565.9ms | 590.8ms | 552.1ms |
| mixed/matrix-multiply | 566.2ms | 621.3ms | 564.2ms |
| mixed/sieve | 555.6ms | 603.0ms | — |
