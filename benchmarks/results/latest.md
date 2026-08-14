# js2wasm Benchmark Results

Date: 2026-08-14
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.047ms | 0.043ms | 0.047ms | FAILED | host-call |
| string/concat-long | 0.004ms | 0.004ms | 0.005ms | FAILED | js |
| string/indexOf | 0.012ms | 0.036ms | 0.008ms | 0.009ms | gc-native |
| string/includes | 0.012ms | 0.027ms | 0.010ms | 0.028ms | gc-native |
| string/split | 0.267ms | 2.88ms | 0.300ms | FAILED | js |
| string/replace | 0.071ms | 0.192ms | 0.052ms | FAILED | gc-native |
| string/case-convert | 0.037ms | 0.124ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.106ms | 0.027ms | 0.023ms | FAILED | gc-native |
| string/trim | 0.185ms | 0.481ms | 0.122ms | FAILED | gc-native |
| string/startsWith-endsWith | 0.360ms | 0.267ms | 0.188ms | 0.392ms | gc-native |
| array/push-pop | 0.944ms | 0.389ms | 0.396ms | FAILED | host-call |
| array/sort-i32 | 0.538ms | 0.288ms | 0.287ms | FAILED | gc-native |
| array/map-filter | 0.113ms | 0.074ms | 0.062ms | FAILED | gc-native |
| array/reduce | 1.51ms | 0.336ms | 0.334ms | FAILED | gc-native |
| array/indexOf | 3.91ms | 1.87ms | 1.87ms | FAILED | host-call |
| array/slice | 0.025ms | 0.024ms | 0.025ms | FAILED | host-call |
| array/reverse | 4.97ms | 2.72ms | 2.72ms | FAILED | gc-native |
| array/forEach | 0.044ms | 0.018ms | 0.021ms | FAILED | host-call |
| array/find | 0.248ms | 0.012ms | 0.012ms | 0.815ms | host-call |
| dom/create-elements | 0.065ms | 0.126ms | — | — | js |
| dom/set-attributes | 0.106ms | 0.346ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.083ms | — | — | js |
| dom/modify-text | 0.041ms | 0.075ms | — | — | js |
| mixed/csv-parse | 0.283ms | 4.01ms | 0.207ms | FAILED | gc-native |
| mixed/text-search | 0.306ms | 0.873ms | 0.186ms | 0.815ms | gc-native |
| mixed/fibonacci | 0.099ms | 0.153ms | 0.153ms | 0.152ms | js |
| mixed/matrix-multiply | 0.143ms | 0.167ms | 0.166ms | 0.632ms | js |
| mixed/sieve | 1.46ms | 1.34ms | 1.34ms | FAILED | host-call |

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
| string/concat-short | 10000 | 4.67 | 4.33 | 4.67 | — |
| string/concat-long | 1000 | 4.17 | 4.20 | 4.78 | — |
| string/indexOf | 1000 | 11.77 | 35.91 | 8.44 | 9.35 |
| string/includes | 1000 | 11.81 | 27.25 | 10.16 | 28.11 |
| string/split | 10000 | 26.73 | 287.80 | 29.98 | — |
| string/replace | 1000 | 70.91 | 191.61 | 52.46 | — |
| string/case-convert | 2000 | 18.27 | 61.94 | 2.37 | — |
| string/substring | 10000 | 10.64 | 2.73 | 2.30 | — |
| string/trim | 10000 | 18.46 | 48.09 | 12.16 | — |
| string/startsWith-endsWith | 20000 | 18.01 | 13.35 | 9.41 | 19.58 |
| array/map-filter | 30000 | 3.76 | 2.48 | 2.06 | — |
| array/indexOf | 1000 | 3906.60 | 1872.40 | 1872.96 | — |
| dom/create-elements | 2000 | 32.60 | 62.76 | — | — |
| dom/set-attributes | 6000 | 17.63 | 57.65 | — | — |
| dom/read-attributes | 3000 | 18.54 | 27.81 | — | — |
| dom/modify-text | 2000 | 20.39 | 37.66 | — | — |
| mixed/csv-parse | 11000 | 25.74 | 364.67 | 18.86 | — |
| mixed/text-search | 40000 | 7.65 | 21.82 | 4.65 | 20.39 |
| mixed/fibonacci | 10000 | 9.86 | 15.28 | 15.28 | 15.19 |
| mixed/matrix-multiply | 125000 | 1.14 | 1.34 | 1.33 | 5.06 |
| mixed/sieve | 200000 | 7.28 | 6.68 | 6.71 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.08x faster | 1.00x slower | — |
| string/concat-long | 1.01x slower | 1.15x slower | — |
| string/indexOf | 3.05x slower | 1.39x faster | 1.26x faster |
| string/includes | 2.31x slower | 1.16x faster | 2.38x slower |
| string/split | 10.77x slower | 1.12x slower | — |
| string/replace | 2.70x slower | 1.35x faster | — |
| string/case-convert | 3.39x slower | 7.72x faster | — |
| string/substring | 3.90x faster | 4.62x faster | — |
| string/trim | 2.60x slower | 1.52x faster | — |
| string/startsWith-endsWith | 1.35x faster | 1.91x faster | 1.09x slower |
| array/push-pop | 2.43x faster | 2.38x faster | — |
| array/sort-i32 | 1.87x faster | 1.88x faster | — |
| array/map-filter | 1.51x faster | 1.82x faster | — |
| array/reduce | 4.49x faster | 4.52x faster | — |
| array/indexOf | 2.09x faster | 2.09x faster | — |
| array/slice | 1.04x faster | 1.02x slower | — |
| array/reverse | 1.83x faster | 1.83x faster | — |
| array/forEach | 2.40x faster | 2.11x faster | — |
| array/find | 20.85x faster | 20.49x faster | 3.28x slower |
| dom/create-elements | 1.92x slower | — | — |
| dom/set-attributes | 3.27x slower | — | — |
| dom/read-attributes | 1.50x slower | — | — |
| dom/modify-text | 1.85x slower | — | — |
| mixed/csv-parse | 14.17x slower | 1.36x faster | — |
| mixed/text-search | 2.85x slower | 1.64x faster | 2.66x slower |
| mixed/fibonacci | 1.55x slower | 1.55x slower | 1.54x slower |
| mixed/matrix-multiply | 1.17x slower | 1.17x slower | 4.42x slower |
| mixed/sieve | 1.09x faster | 1.08x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.08x slower |
| string/concat-long | 1.14x slower |
| string/indexOf | 4.25x faster |
| string/includes | 2.68x faster |
| string/split | 9.60x faster |
| string/replace | 3.65x faster |
| string/case-convert | 26.18x faster |
| string/substring | 1.19x faster |
| string/trim | 3.95x faster |
| string/startsWith-endsWith | 1.42x faster |
| array/push-pop | 1.02x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.20x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.06x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.14x slower |
| array/find | 1.02x slower |
| mixed/csv-parse | 19.34x faster |
| mixed/text-search | 4.69x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
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
| string/concat-short | 871.5ms | 764.3ms | — |
| string/concat-long | 451.6ms | 677.7ms | — |
| string/indexOf | 477.8ms | 666.2ms | 590.7ms |
| string/includes | 467.5ms | 698.4ms | 585.1ms |
| string/split | 545.4ms | 689.8ms | — |
| string/replace | 603.3ms | 830.3ms | — |
| string/case-convert | 523.5ms | 590.1ms | — |
| string/substring | 475.9ms | 533.5ms | — |
| string/trim | 524.5ms | 676.7ms | — |
| string/startsWith-endsWith | 544.4ms | 668.1ms | 652.0ms |
| array/push-pop | 533.2ms | 591.4ms | — |
| array/sort-i32 | 725.9ms | 738.6ms | — |
| array/map-filter | 707.0ms | 769.5ms | — |
| array/reduce | 578.0ms | 641.3ms | — |
| array/indexOf | 572.6ms | 629.3ms | — |
| array/slice | 540.9ms | 580.7ms | — |
| array/reverse | 546.3ms | 571.4ms | — |
| array/forEach | 617.8ms | 657.0ms | — |
| array/find | 578.5ms | 644.1ms | 649.1ms |
| dom/create-elements | 468.5ms | — | — |
| dom/set-attributes | 497.0ms | — | — |
| dom/read-attributes | 486.4ms | — | — |
| dom/modify-text | 423.7ms | — | — |
| mixed/csv-parse | 556.3ms | 689.9ms | — |
| mixed/text-search | 545.0ms | 694.1ms | 614.3ms |
| mixed/fibonacci | 595.5ms | 610.9ms | 555.7ms |
| mixed/matrix-multiply | 592.0ms | 618.3ms | 594.6ms |
| mixed/sieve | 637.1ms | 681.6ms | — |
