# js2wasm Benchmark Results

Date: 2026-09-12
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.055ms | 0.050ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.067ms | 0.012ms | 0.018ms | gc-native |
| string/includes | 0.019ms | 0.122ms | 0.014ms | 0.017ms | gc-native |
| string/split | 0.422ms | 7.66ms | 2.62ms | FAILED | js |
| string/replace | 0.094ms | 0.576ms | 0.270ms | FAILED | js |
| string/case-convert | 0.058ms | 0.533ms | 0.239ms | FAILED | js |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.175ms | 3.28ms | 2.33ms | FAILED | js |
| string/startsWith-endsWith | 0.412ms | 2.43ms | 2.43ms | 0.559ms | js |
| array/push-pop | 1.63ms | 0.597ms | 0.595ms | FAILED | gc-native |
| array/sort-i32 | 0.841ms | 0.302ms | 0.304ms | FAILED | host-call |
| array/map-filter | 0.141ms | 0.066ms | 0.066ms | FAILED | host-call |
| array/reduce | 1.59ms | 0.593ms | 0.598ms | FAILED | host-call |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.035ms | 0.017ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.84ms | 3.97ms | 3.97ms | FAILED | host-call |
| array/forEach | 0.052ms | 0.029ms | 0.029ms | FAILED | host-call |
| array/find | 0.273ms | 0.015ms | 0.015ms | 1.12ms | gc-native |
| dom/create-elements | 0.236ms | 0.105ms | — | — | host-call |
| dom/set-attributes | 0.112ms | 0.238ms | — | — | js |
| dom/read-attributes | 0.063ms | 0.135ms | — | — | js |
| dom/modify-text | 0.033ms | 0.115ms | — | — | js |
| mixed/csv-parse | 0.972ms | 8.04ms | 0.538ms | FAILED | gc-native |
| mixed/text-search | 0.403ms | 4.21ms | 2.39ms | 1.13ms | js |
| mixed/fibonacci | 0.126ms | 0.327ms | 0.328ms | 0.325ms | js |
| mixed/matrix-multiply | 0.186ms | 64.02ms | 65.34ms | 0.722ms | js |
| mixed/sieve | 1.79ms | 2.30ms | 2.31ms | FAILED | js |

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
| string/concat-short | 10000 | 3.44 | 5.48 | 4.96 | — |
| string/concat-long | 1000 | 4.31 | 5.37 | 3.36 | — |
| string/indexOf | 1000 | 18.98 | 67.10 | 12.17 | 17.85 |
| string/includes | 1000 | 18.75 | 122.50 | 13.74 | 17.17 |
| string/split | 10000 | 42.22 | 766.25 | 261.97 | — |
| string/replace | 1000 | 93.91 | 576.42 | 270.09 | — |
| string/case-convert | 2000 | 29.09 | 266.45 | 119.26 | — |
| string/substring | 10000 | 10.42 | 3.99 | 3.43 | — |
| string/trim | 10000 | 17.54 | 328.49 | 233.02 | — |
| string/startsWith-endsWith | 20000 | 20.62 | 121.34 | 121.69 | 27.97 |
| array/map-filter | 30000 | 4.70 | 2.19 | 2.19 | — |
| array/indexOf | 1000 | 4457.26 | 2864.36 | 2859.35 | — |
| dom/create-elements | 2000 | 118.11 | 52.30 | — | — |
| dom/set-attributes | 6000 | 18.63 | 39.73 | — | — |
| dom/read-attributes | 3000 | 20.94 | 44.97 | — | — |
| dom/modify-text | 2000 | 16.41 | 57.72 | — | — |
| mixed/csv-parse | 11000 | 88.35 | 730.75 | 48.88 | — |
| mixed/text-search | 40000 | 10.07 | 105.34 | 59.85 | 28.17 |
| mixed/fibonacci | 10000 | 12.60 | 32.74 | 32.76 | 32.51 |
| mixed/matrix-multiply | 125000 | 1.49 | 512.15 | 522.70 | 5.77 |
| mixed/sieve | 200000 | 8.97 | 11.51 | 11.56 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.59x slower | 1.44x slower | — |
| string/concat-long | 1.25x slower | 1.28x faster | — |
| string/indexOf | 3.53x slower | 1.56x faster | 1.06x faster |
| string/includes | 6.53x slower | 1.36x faster | 1.09x faster |
| string/split | 18.15x slower | 6.20x slower | — |
| string/replace | 6.14x slower | 2.88x slower | — |
| string/case-convert | 9.16x slower | 4.10x slower | — |
| string/substring | 2.61x faster | 3.04x faster | — |
| string/trim | 18.73x slower | 13.29x slower | — |
| string/startsWith-endsWith | 5.88x slower | 5.90x slower | 1.36x slower |
| array/push-pop | 2.72x faster | 2.73x faster | — |
| array/sort-i32 | 2.78x faster | 2.77x faster | — |
| array/map-filter | 2.15x faster | 2.15x faster | — |
| array/reduce | 2.69x faster | 2.66x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.10x faster | 2.06x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.84x faster | 1.84x faster | — |
| array/find | 18.57x faster | 18.59x faster | 4.10x slower |
| dom/create-elements | 2.26x faster | — | — |
| dom/set-attributes | 2.13x slower | — | — |
| dom/read-attributes | 2.15x slower | — | — |
| dom/modify-text | 3.52x slower | — | — |
| mixed/csv-parse | 8.27x slower | 1.81x faster | — |
| mixed/text-search | 10.46x slower | 5.95x slower | 2.80x slower |
| mixed/fibonacci | 2.60x slower | 2.60x slower | 2.58x slower |
| mixed/matrix-multiply | 344.31x slower | 351.40x slower | 3.88x slower |
| mixed/sieve | 1.28x slower | 1.29x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.10x faster |
| string/concat-long | 1.60x faster |
| string/indexOf | 5.51x faster |
| string/includes | 8.91x faster |
| string/split | 2.92x faster |
| string/replace | 2.13x faster |
| string/case-convert | 2.23x faster |
| string/substring | 1.16x faster |
| string/trim | 1.41x faster |
| string/startsWith-endsWith | 1.00x slower |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.02x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.00x faster |
| mixed/csv-parse | 14.95x faster |
| mixed/text-search | 1.76x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.02x slower |
| mixed/sieve | 1.00x slower |

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
| string/concat-short | 1105.8ms | 624.5ms | — |
| string/concat-long | 445.4ms | 678.9ms | — |
| string/indexOf | 378.5ms | 657.1ms | 561.7ms |
| string/includes | 384.7ms | 695.6ms | 568.7ms |
| string/split | 497.9ms | 668.1ms | — |
| string/replace | 501.8ms | 728.0ms | — |
| string/case-convert | 499.7ms | 588.3ms | — |
| string/substring | 404.2ms | 461.3ms | — |
| string/trim | 495.3ms | 669.5ms | — |
| string/startsWith-endsWith | 481.6ms | 672.2ms | 613.0ms |
| array/push-pop | 497.7ms | 509.6ms | — |
| array/sort-i32 | 651.5ms | 687.2ms | — |
| array/map-filter | 657.5ms | 737.9ms | — |
| array/reduce | 573.9ms | 579.1ms | — |
| array/indexOf | 556.5ms | 663.8ms | — |
| array/slice | 501.3ms | 575.7ms | — |
| array/reverse | 482.2ms | 585.3ms | — |
| array/forEach | 619.3ms | 705.4ms | — |
| array/find | 481.2ms | 609.4ms | 537.7ms |
| dom/create-elements | 439.8ms | — | — |
| dom/set-attributes | 429.9ms | — | — |
| dom/read-attributes | 420.6ms | — | — |
| dom/modify-text | 402.1ms | — | — |
| mixed/csv-parse | 500.8ms | 678.5ms | — |
| mixed/text-search | 496.5ms | 681.3ms | 628.5ms |
| mixed/fibonacci | 495.2ms | 511.4ms | 476.5ms |
| mixed/matrix-multiply | 648.8ms | 698.4ms | 531.9ms |
| mixed/sieve | 584.2ms | 661.3ms | — |
