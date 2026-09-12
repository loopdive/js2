# js2wasm Benchmark Results

Date: 2026-09-12
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.039ms | 0.047ms | 0.048ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.113ms | 0.015ms | 0.020ms | gc-native |
| string/split | 0.429ms | 8.27ms | 2.73ms | FAILED | js |
| string/replace | 0.109ms | 0.686ms | 0.323ms | FAILED | js |
| string/case-convert | 0.060ms | 0.581ms | 0.264ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.176ms | 3.95ms | 2.76ms | FAILED | js |
| string/startsWith-endsWith | 0.400ms | 2.84ms | 3.21ms | 0.561ms | js |
| array/push-pop | 1.50ms | 0.517ms | 0.525ms | FAILED | host-call |
| array/sort-i32 | 0.801ms | 0.296ms | 0.293ms | FAILED | gc-native |
| array/map-filter | 0.135ms | 0.073ms | 0.074ms | FAILED | host-call |
| array/reduce | 2.21ms | 0.518ms | 0.534ms | FAILED | host-call |
| array/indexOf | 3.96ms | 2.65ms | 2.65ms | FAILED | gc-native |
| array/slice | 0.031ms | 0.032ms | 0.032ms | FAILED | js |
| array/reverse | 7.84ms | 3.52ms | 3.53ms | FAILED | host-call |
| array/forEach | 0.051ms | 0.029ms | 0.031ms | FAILED | host-call |
| array/find | 0.258ms | 0.017ms | 0.017ms | 1.08ms | host-call |
| dom/create-elements | 0.040ms | 0.095ms | — | — | js |
| dom/set-attributes | 0.110ms | 0.222ms | — | — | js |
| dom/read-attributes | 0.060ms | 0.122ms | — | — | js |
| dom/modify-text | 0.036ms | 0.110ms | — | — | js |
| mixed/csv-parse | 1.00ms | 8.54ms | 0.626ms | FAILED | gc-native |
| mixed/text-search | 0.389ms | 4.89ms | 2.96ms | 1.09ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.161ms | 72.37ms | 71.86ms | 0.722ms | js |
| mixed/sieve | 1.67ms | 2.13ms | 2.14ms | FAILED | js |

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
| string/concat-short | 10000 | 3.86 | 4.75 | 4.78 | — |
| string/concat-long | 1000 | 3.85 | 4.58 | 4.07 | — |
| string/indexOf | 1000 | 19.22 | 64.19 | 12.44 | 14.74 |
| string/includes | 1000 | 19.28 | 112.75 | 14.81 | 19.60 |
| string/split | 10000 | 42.86 | 827.46 | 272.99 | — |
| string/replace | 1000 | 109.30 | 686.23 | 323.20 | — |
| string/case-convert | 2000 | 29.81 | 290.71 | 132.13 | — |
| string/substring | 10000 | 9.95 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.64 | 394.55 | 275.93 | — |
| string/startsWith-endsWith | 20000 | 20.00 | 141.79 | 160.29 | 28.06 |
| array/map-filter | 30000 | 4.51 | 2.44 | 2.46 | — |
| array/indexOf | 1000 | 3959.68 | 2647.73 | 2645.28 | — |
| dom/create-elements | 2000 | 19.76 | 47.63 | — | — |
| dom/set-attributes | 6000 | 18.40 | 36.93 | — | — |
| dom/read-attributes | 3000 | 19.93 | 40.80 | — | — |
| dom/modify-text | 2000 | 18.04 | 55.08 | — | — |
| mixed/csv-parse | 11000 | 91.15 | 776.58 | 56.92 | — |
| mixed/text-search | 40000 | 9.73 | 122.32 | 74.12 | 27.25 |
| mixed/fibonacci | 10000 | 12.18 | 28.34 | 28.33 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.29 | 578.96 | 574.87 | 5.78 |
| mixed/sieve | 200000 | 8.33 | 10.66 | 10.72 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.23x slower | 1.24x slower | — |
| string/concat-long | 1.19x slower | 1.06x slower | — |
| string/indexOf | 3.34x slower | 1.54x faster | 1.30x faster |
| string/includes | 5.85x slower | 1.30x faster | 1.02x slower |
| string/split | 19.30x slower | 6.37x slower | — |
| string/replace | 6.28x slower | 2.96x slower | — |
| string/case-convert | 9.75x slower | 4.43x slower | — |
| string/substring | 2.66x faster | 3.24x faster | — |
| string/trim | 22.37x slower | 15.65x slower | — |
| string/startsWith-endsWith | 7.09x slower | 8.01x slower | 1.40x slower |
| array/push-pop | 2.89x faster | 2.85x faster | — |
| array/sort-i32 | 2.71x faster | 2.73x faster | — |
| array/map-filter | 1.85x faster | 1.83x faster | — |
| array/reduce | 4.27x faster | 4.14x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.03x slower | 1.01x slower | — |
| array/reverse | 2.23x faster | 2.22x faster | — |
| array/forEach | 1.76x faster | 1.65x faster | — |
| array/find | 15.57x faster | 15.45x faster | 4.17x slower |
| dom/create-elements | 2.41x slower | — | — |
| dom/set-attributes | 2.01x slower | — | — |
| dom/read-attributes | 2.05x slower | — | — |
| dom/modify-text | 3.05x slower | — | — |
| mixed/csv-parse | 8.52x slower | 1.60x faster | — |
| mixed/text-search | 12.57x slower | 7.62x slower | 2.80x slower |
| mixed/fibonacci | 2.33x slower | 2.33x slower | 2.31x slower |
| mixed/matrix-multiply | 449.42x slower | 446.25x slower | 4.49x slower |
| mixed/sieve | 1.28x slower | 1.29x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.01x slower |
| string/concat-long | 1.13x faster |
| string/indexOf | 5.16x faster |
| string/includes | 7.61x faster |
| string/split | 3.03x faster |
| string/replace | 2.12x faster |
| string/case-convert | 2.20x faster |
| string/substring | 1.22x faster |
| string/trim | 1.43x faster |
| string/startsWith-endsWith | 1.13x slower |
| array/push-pop | 1.02x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.01x slower |
| array/reduce | 1.03x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.02x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.07x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 13.64x faster |
| mixed/text-search | 1.65x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.01x faster |
| mixed/sieve | 1.01x slower |

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
| string/concat-short | 1192.6ms | 663.0ms | — |
| string/concat-long | 484.6ms | 716.0ms | — |
| string/indexOf | 415.0ms | 718.4ms | 590.6ms |
| string/includes | 395.3ms | 703.0ms | 591.2ms |
| string/split | 504.5ms | 735.7ms | — |
| string/replace | 517.3ms | 792.5ms | — |
| string/case-convert | 541.4ms | 682.5ms | — |
| string/substring | 417.8ms | 515.4ms | — |
| string/trim | 496.4ms | 737.2ms | — |
| string/startsWith-endsWith | 519.3ms | 717.3ms | 711.6ms |
| array/push-pop | 529.7ms | 608.6ms | — |
| array/sort-i32 | 670.6ms | 737.6ms | — |
| array/map-filter | 718.5ms | 784.4ms | — |
| array/reduce | 625.9ms | 739.3ms | — |
| array/indexOf | 600.7ms | 709.2ms | — |
| array/slice | 542.2ms | 604.4ms | — |
| array/reverse | 517.0ms | 603.8ms | — |
| array/forEach | 676.5ms | 735.8ms | — |
| array/find | 511.0ms | 613.5ms | 567.7ms |
| dom/create-elements | 460.4ms | — | — |
| dom/set-attributes | 451.2ms | — | — |
| dom/read-attributes | 444.9ms | — | — |
| dom/modify-text | 425.6ms | — | — |
| mixed/csv-parse | 528.2ms | 734.6ms | — |
| mixed/text-search | 525.6ms | 725.9ms | 644.6ms |
| mixed/fibonacci | 502.5ms | 559.3ms | 506.5ms |
| mixed/matrix-multiply | 671.3ms | 725.0ms | 559.6ms |
| mixed/sieve | 605.4ms | 687.4ms | — |
