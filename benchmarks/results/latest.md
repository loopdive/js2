# js2wasm Benchmark Results

Date: 2026-10-10
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.049ms | 0.045ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.136ms | 0.015ms | 0.019ms | gc-native |
| string/split | 0.426ms | 8.51ms | 2.72ms | FAILED | js |
| string/replace | 0.101ms | 0.700ms | 0.311ms | FAILED | js |
| string/case-convert | 0.057ms | 0.601ms | 0.258ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.174ms | 3.84ms | 2.70ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 2.87ms | 2.86ms | 0.559ms | js |
| array/push-pop | 1.41ms | 0.505ms | 0.506ms | FAILED | host-call |
| array/sort-i32 | 0.790ms | 0.294ms | 0.294ms | FAILED | gc-native |
| array/map-filter | 0.129ms | 0.071ms | 0.071ms | FAILED | gc-native |
| array/reduce | 2.17ms | 0.510ms | 0.509ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.64ms | 2.65ms | FAILED | host-call |
| array/slice | 0.026ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.84ms | 3.52ms | 3.53ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.254ms | 0.016ms | 0.017ms | 1.08ms | host-call |
| dom/create-elements | 0.036ms | 0.095ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.222ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.127ms | — | — | js |
| dom/modify-text | 0.029ms | 0.108ms | — | — | js |
| mixed/csv-parse | 0.489ms | 8.68ms | 0.626ms | FAILED | js |
| mixed/text-search | 0.389ms | 5.35ms | 2.90ms | 1.09ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.289ms | js |
| mixed/matrix-multiply | 0.158ms | 71.36ms | 77.65ms | 0.721ms | js |
| mixed/sieve | 1.60ms | 2.11ms | 2.13ms | FAILED | js |

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
| string/concat-short | 10000 | 3.34 | 4.91 | 4.51 | — |
| string/concat-long | 1000 | 3.61 | 4.58 | 3.79 | — |
| string/indexOf | 1000 | 19.18 | 63.86 | 12.36 | 14.61 |
| string/includes | 1000 | 19.39 | 135.93 | 14.61 | 18.89 |
| string/split | 10000 | 42.58 | 850.60 | 271.86 | — |
| string/replace | 1000 | 101.24 | 699.53 | 311.42 | — |
| string/case-convert | 2000 | 28.39 | 300.29 | 128.84 | — |
| string/substring | 10000 | 9.89 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.38 | 383.62 | 269.94 | — |
| string/startsWith-endsWith | 20000 | 20.10 | 143.51 | 143.10 | 27.97 |
| array/map-filter | 30000 | 4.29 | 2.36 | 2.36 | — |
| array/indexOf | 1000 | 3950.75 | 2644.85 | 2645.84 | — |
| dom/create-elements | 2000 | 17.75 | 47.36 | — | — |
| dom/set-attributes | 6000 | 17.35 | 37.04 | — | — |
| dom/read-attributes | 3000 | 18.47 | 42.34 | — | — |
| dom/modify-text | 2000 | 14.67 | 54.21 | — | — |
| mixed/csv-parse | 11000 | 44.45 | 789.25 | 56.93 | — |
| mixed/text-search | 40000 | 9.72 | 133.65 | 72.42 | 27.15 |
| mixed/fibonacci | 10000 | 12.02 | 28.30 | 28.32 | 28.89 |
| mixed/matrix-multiply | 125000 | 1.27 | 570.85 | 621.22 | 5.77 |
| mixed/sieve | 200000 | 7.98 | 10.57 | 10.63 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.47x slower | 1.35x slower | — |
| string/concat-long | 1.27x slower | 1.05x slower | — |
| string/indexOf | 3.33x slower | 1.55x faster | 1.31x faster |
| string/includes | 7.01x slower | 1.33x faster | 1.03x faster |
| string/split | 19.98x slower | 6.39x slower | — |
| string/replace | 6.91x slower | 3.08x slower | — |
| string/case-convert | 10.58x slower | 4.54x slower | — |
| string/substring | 2.65x faster | 3.22x faster | — |
| string/trim | 22.07x slower | 15.53x slower | — |
| string/startsWith-endsWith | 7.14x slower | 7.12x slower | 1.39x slower |
| array/push-pop | 2.80x faster | 2.79x faster | — |
| array/sort-i32 | 2.69x faster | 2.69x faster | — |
| array/map-filter | 1.82x faster | 1.82x faster | — |
| array/reduce | 4.26x faster | 4.27x faster | — |
| array/indexOf | 1.49x faster | 1.49x faster | — |
| array/slice | 1.07x slower | 1.07x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.75x faster | 1.75x faster | — |
| array/find | 15.98x faster | 15.36x faster | 4.25x slower |
| dom/create-elements | 2.67x slower | — | — |
| dom/set-attributes | 2.14x slower | — | — |
| dom/read-attributes | 2.29x slower | — | — |
| dom/modify-text | 3.70x slower | — | — |
| mixed/csv-parse | 17.76x slower | 1.28x slower | — |
| mixed/text-search | 13.75x slower | 7.45x slower | 2.79x slower |
| mixed/fibonacci | 2.35x slower | 2.36x slower | 2.40x slower |
| mixed/matrix-multiply | 450.80x slower | 490.57x slower | 4.55x slower |
| mixed/sieve | 1.32x slower | 1.33x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.09x faster |
| string/concat-long | 1.21x faster |
| string/indexOf | 5.16x faster |
| string/includes | 9.30x faster |
| string/split | 3.13x faster |
| string/replace | 2.25x faster |
| string/case-convert | 2.33x faster |
| string/substring | 1.22x faster |
| string/trim | 1.42x faster |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.00x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.04x slower |
| mixed/csv-parse | 13.86x faster |
| mixed/text-search | 1.85x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.09x slower |
| mixed/sieve | 1.01x slower |

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
| mixed/matrix-multiply | 3.5KB | 4.0KB | 991B |
| mixed/sieve | 2.5KB | 2.7KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1181.8ms | 622.4ms | — |
| string/concat-long | 450.4ms | 660.0ms | — |
| string/indexOf | 380.6ms | 673.6ms | 556.8ms |
| string/includes | 390.4ms | 695.4ms | 557.6ms |
| string/split | 531.6ms | 692.7ms | — |
| string/replace | 507.1ms | 756.1ms | — |
| string/case-convert | 575.5ms | 619.6ms | — |
| string/substring | 388.9ms | 482.3ms | — |
| string/trim | 472.8ms | 716.3ms | — |
| string/startsWith-endsWith | 500.5ms | 694.0ms | 636.8ms |
| array/push-pop | 505.3ms | 602.6ms | — |
| array/sort-i32 | 666.8ms | 723.3ms | — |
| array/map-filter | 695.0ms | 749.2ms | — |
| array/reduce | 600.3ms | 704.6ms | — |
| array/indexOf | 591.9ms | 663.7ms | — |
| array/slice | 510.2ms | 608.6ms | — |
| array/reverse | 509.9ms | 580.5ms | — |
| array/forEach | 666.2ms | 700.8ms | — |
| array/find | 480.2ms | 575.3ms | 540.4ms |
| dom/create-elements | 414.0ms | — | — |
| dom/set-attributes | 376.3ms | — | — |
| dom/read-attributes | 383.1ms | — | — |
| dom/modify-text | 374.7ms | — | — |
| mixed/csv-parse | 519.7ms | 681.4ms | — |
| mixed/text-search | 499.0ms | 713.4ms | 633.5ms |
| mixed/fibonacci | 464.4ms | 533.9ms | 479.5ms |
| mixed/matrix-multiply | 652.7ms | 718.2ms | 529.1ms |
| mixed/sieve | 600.4ms | 704.5ms | — |
