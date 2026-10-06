# js2wasm Benchmark Results

Date: 2026-10-06
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.052ms | 0.045ms | 0.045ms | FAILED | host-call |
| string/concat-long | 0.003ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.016ms | 0.051ms | 0.011ms | 0.013ms | gc-native |
| string/includes | 0.016ms | 0.105ms | 0.013ms | 0.019ms | gc-native |
| string/split | 0.373ms | 6.62ms | 2.39ms | FAILED | js |
| string/replace | 0.095ms | 0.504ms | 0.288ms | FAILED | js |
| string/case-convert | 0.050ms | 0.474ms | 0.240ms | FAILED | js |
| string/substring | 0.112ms | 0.036ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.162ms | 3.38ms | 2.48ms | FAILED | js |
| string/startsWith-endsWith | 0.452ms | 2.69ms | 2.66ms | 0.542ms | js |
| array/push-pop | 1.29ms | 0.461ms | 0.442ms | FAILED | gc-native |
| array/sort-i32 | 0.615ms | 0.323ms | 0.324ms | FAILED | host-call |
| array/map-filter | 0.133ms | 0.076ms | 0.074ms | FAILED | gc-native |
| array/reduce | 1.24ms | 0.423ms | 0.413ms | FAILED | gc-native |
| array/indexOf | 5.07ms | 2.51ms | 2.51ms | FAILED | host-call |
| array/slice | 0.017ms | 0.017ms | 0.017ms | FAILED | gc-native |
| array/reverse | 7.96ms | 3.59ms | 3.58ms | FAILED | gc-native |
| array/forEach | 0.052ms | 0.021ms | 0.021ms | FAILED | host-call |
| array/find | 0.272ms | 0.013ms | 0.013ms | 0.944ms | gc-native |
| dom/create-elements | 0.037ms | 0.095ms | — | — | js |
| dom/set-attributes | 0.106ms | 0.188ms | — | — | js |
| dom/read-attributes | 0.044ms | 0.105ms | — | — | js |
| dom/modify-text | 0.032ms | 0.089ms | — | — | js |
| mixed/csv-parse | 0.380ms | 6.83ms | 0.555ms | FAILED | js |
| mixed/text-search | 0.422ms | 3.87ms | 2.51ms | 1.11ms | js |
| mixed/fibonacci | 0.128ms | 0.210ms | 0.204ms | 0.202ms | js |
| mixed/matrix-multiply | 0.179ms | 61.25ms | 63.57ms | 0.692ms | js |
| mixed/sieve | 1.49ms | 2.36ms | 2.37ms | FAILED | js |

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
| string/concat-short | 10000 | 5.24 | 4.45 | 4.47 | — |
| string/concat-long | 1000 | 3.47 | 3.74 | 3.87 | — |
| string/indexOf | 1000 | 15.97 | 51.47 | 10.76 | 13.31 |
| string/includes | 1000 | 15.98 | 104.73 | 13.37 | 19.25 |
| string/split | 10000 | 37.30 | 661.56 | 238.55 | — |
| string/replace | 1000 | 94.91 | 504.02 | 287.58 | — |
| string/case-convert | 2000 | 24.75 | 237.03 | 119.78 | — |
| string/substring | 10000 | 11.20 | 3.63 | 3.08 | — |
| string/trim | 10000 | 16.23 | 338.40 | 248.38 | — |
| string/startsWith-endsWith | 20000 | 22.60 | 134.58 | 133.13 | 27.11 |
| array/map-filter | 30000 | 4.44 | 2.54 | 2.48 | — |
| array/indexOf | 1000 | 5073.16 | 2508.01 | 2508.59 | — |
| dom/create-elements | 2000 | 18.68 | 47.66 | — | — |
| dom/set-attributes | 6000 | 17.69 | 31.31 | — | — |
| dom/read-attributes | 3000 | 14.66 | 35.04 | — | — |
| dom/modify-text | 2000 | 15.84 | 44.35 | — | — |
| mixed/csv-parse | 11000 | 34.56 | 620.65 | 50.45 | — |
| mixed/text-search | 40000 | 10.54 | 96.70 | 62.68 | 27.84 |
| mixed/fibonacci | 10000 | 12.79 | 20.98 | 20.42 | 20.23 |
| mixed/matrix-multiply | 125000 | 1.43 | 490.02 | 508.58 | 5.54 |
| mixed/sieve | 200000 | 7.43 | 11.81 | 11.84 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.18x faster | 1.17x faster | — |
| string/concat-long | 1.08x slower | 1.12x slower | — |
| string/indexOf | 3.22x slower | 1.48x faster | 1.20x faster |
| string/includes | 6.56x slower | 1.19x faster | 1.20x slower |
| string/split | 17.73x slower | 6.40x slower | — |
| string/replace | 5.31x slower | 3.03x slower | — |
| string/case-convert | 9.58x slower | 4.84x slower | — |
| string/substring | 3.09x faster | 3.64x faster | — |
| string/trim | 20.85x slower | 15.30x slower | — |
| string/startsWith-endsWith | 5.95x slower | 5.89x slower | 1.20x slower |
| array/push-pop | 2.80x faster | 2.92x faster | — |
| array/sort-i32 | 1.90x faster | 1.90x faster | — |
| array/map-filter | 1.75x faster | 1.79x faster | — |
| array/reduce | 2.94x faster | 3.01x faster | — |
| array/indexOf | 2.02x faster | 2.02x faster | — |
| array/slice | 1.01x faster | 1.02x faster | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 2.46x faster | 2.44x faster | — |
| array/find | 21.48x faster | 21.63x faster | 3.46x slower |
| dom/create-elements | 2.55x slower | — | — |
| dom/set-attributes | 1.77x slower | — | — |
| dom/read-attributes | 2.39x slower | — | — |
| dom/modify-text | 2.80x slower | — | — |
| mixed/csv-parse | 17.96x slower | 1.46x slower | — |
| mixed/text-search | 9.17x slower | 5.95x slower | 2.64x slower |
| mixed/fibonacci | 1.64x slower | 1.60x slower | 1.58x slower |
| mixed/matrix-multiply | 342.25x slower | 355.21x slower | 3.87x slower |
| mixed/sieve | 1.59x slower | 1.59x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.00x slower |
| string/concat-long | 1.03x slower |
| string/indexOf | 4.79x faster |
| string/includes | 7.83x faster |
| string/split | 2.77x faster |
| string/replace | 1.75x faster |
| string/case-convert | 1.98x faster |
| string/substring | 1.18x faster |
| string/trim | 1.36x faster |
| string/startsWith-endsWith | 1.01x faster |
| array/push-pop | 1.04x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.03x faster |
| array/reduce | 1.02x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 12.30x faster |
| mixed/text-search | 1.54x faster |
| mixed/fibonacci | 1.03x faster |
| mixed/matrix-multiply | 1.04x slower |
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
| string/concat-short | 1043.7ms | 574.7ms | — |
| string/concat-long | 414.6ms | 610.3ms | — |
| string/indexOf | 349.2ms | 641.6ms | 523.1ms |
| string/includes | 349.4ms | 641.6ms | 526.1ms |
| string/split | 478.5ms | 660.0ms | — |
| string/replace | 484.3ms | 711.6ms | — |
| string/case-convert | 489.8ms | 572.2ms | — |
| string/substring | 366.8ms | 437.3ms | — |
| string/trim | 467.0ms | 640.4ms | — |
| string/startsWith-endsWith | 459.2ms | 645.6ms | 577.4ms |
| array/push-pop | 485.8ms | 554.1ms | — |
| array/sort-i32 | 641.1ms | 674.2ms | — |
| array/map-filter | 662.8ms | 730.5ms | — |
| array/reduce | 565.8ms | 661.6ms | — |
| array/indexOf | 567.8ms | 640.4ms | — |
| array/slice | 502.0ms | 572.7ms | — |
| array/reverse | 476.3ms | 540.3ms | — |
| array/forEach | 623.8ms | 660.7ms | — |
| array/find | 459.2ms | 568.5ms | 521.3ms |
| dom/create-elements | 387.3ms | — | — |
| dom/set-attributes | 354.4ms | — | — |
| dom/read-attributes | 363.6ms | — | — |
| dom/modify-text | 369.1ms | — | — |
| mixed/csv-parse | 509.0ms | 655.6ms | — |
| mixed/text-search | 493.6ms | 669.0ms | 608.5ms |
| mixed/fibonacci | 422.6ms | 490.1ms | 438.5ms |
| mixed/matrix-multiply | 588.3ms | 674.4ms | 504.3ms |
| mixed/sieve | 598.5ms | 661.1ms | — |
