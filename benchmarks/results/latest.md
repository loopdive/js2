# js2wasm Benchmark Results

Date: 2026-08-22
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.039ms | 0.043ms | FAILED | js |
| string/concat-long | 0.005ms | 0.004ms | 0.004ms | FAILED | host-call |
| string/indexOf | 0.014ms | 0.044ms | 0.010ms | 0.033ms | gc-native |
| string/includes | 0.014ms | 0.089ms | 0.012ms | 0.012ms | linear-memory |
| string/split | 0.302ms | 3.70ms | 0.359ms | FAILED | js |
| string/replace | 0.089ms | 0.229ms | 0.047ms | FAILED | gc-native |
| string/case-convert | 0.044ms | 0.160ms | 0.004ms | FAILED | gc-native |
| string/substring | 0.091ms | 0.033ms | 0.028ms | FAILED | gc-native |
| string/trim | 0.139ms | 0.626ms | 0.145ms | FAILED | js |
| string/startsWith-endsWith | 0.412ms | 0.290ms | 0.226ms | 0.482ms | gc-native |
| array/push-pop | 1.25ms | 0.396ms | 0.387ms | FAILED | gc-native |
| array/sort-i32 | 0.563ms | 0.293ms | 0.294ms | FAILED | host-call |
| array/map-filter | 0.116ms | 0.068ms | 0.067ms | FAILED | gc-native |
| array/reduce | 1.12ms | 0.368ms | 0.410ms | FAILED | host-call |
| array/indexOf | 4.59ms | 2.27ms | 2.26ms | FAILED | gc-native |
| array/slice | 0.018ms | 0.022ms | 0.017ms | FAILED | gc-native |
| array/reverse | 7.25ms | 3.23ms | 3.26ms | FAILED | host-call |
| array/forEach | 0.076ms | 0.019ms | 0.023ms | FAILED | host-call |
| array/find | 0.432ms | 0.012ms | 0.012ms | 0.845ms | gc-native |
| dom/create-elements | 0.035ms | 0.127ms | — | — | js |
| dom/set-attributes | 0.096ms | 0.413ms | — | — | js |
| dom/read-attributes | 0.045ms | 0.094ms | — | — | js |
| dom/modify-text | 0.031ms | 0.079ms | — | — | js |
| mixed/csv-parse | 0.346ms | 5.19ms | 0.266ms | FAILED | gc-native |
| mixed/text-search | 0.377ms | 1.09ms | 0.225ms | 0.993ms | gc-native |
| mixed/fibonacci | 0.116ms | 0.184ms | 0.183ms | 0.183ms | js |
| mixed/matrix-multiply | 0.165ms | 0.168ms | 0.195ms | 0.611ms | js |
| mixed/sieve | 1.34ms | 1.38ms | 1.40ms | FAILED | js |

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
| string/concat-short | 10000 | 3.47 | 3.85 | 4.33 | — |
| string/concat-long | 1000 | 4.62 | 3.91 | 4.00 | — |
| string/indexOf | 1000 | 14.36 | 43.87 | 9.96 | 32.61 |
| string/includes | 1000 | 14.21 | 89.00 | 12.47 | 12.25 |
| string/split | 10000 | 30.25 | 370.36 | 35.90 | — |
| string/replace | 1000 | 88.79 | 228.52 | 46.71 | — |
| string/case-convert | 2000 | 21.82 | 80.17 | 2.20 | — |
| string/substring | 10000 | 9.06 | 3.27 | 2.80 | — |
| string/trim | 10000 | 13.85 | 62.55 | 14.52 | — |
| string/startsWith-endsWith | 20000 | 20.58 | 14.48 | 11.29 | 24.12 |
| array/map-filter | 30000 | 3.85 | 2.28 | 2.24 | — |
| array/indexOf | 1000 | 4594.69 | 2272.30 | 2262.20 | — |
| dom/create-elements | 2000 | 17.53 | 63.27 | — | — |
| dom/set-attributes | 6000 | 16.08 | 68.86 | — | — |
| dom/read-attributes | 3000 | 15.15 | 31.43 | — | — |
| dom/modify-text | 2000 | 15.47 | 39.29 | — | — |
| mixed/csv-parse | 11000 | 31.48 | 471.42 | 24.23 | — |
| mixed/text-search | 40000 | 9.42 | 27.26 | 5.62 | 24.83 |
| mixed/fibonacci | 10000 | 11.61 | 18.40 | 18.33 | 18.32 |
| mixed/matrix-multiply | 125000 | 1.32 | 1.34 | 1.56 | 4.89 |
| mixed/sieve | 200000 | 6.70 | 6.88 | 6.98 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.11x slower | 1.25x slower | — |
| string/concat-long | 1.18x faster | 1.16x faster | — |
| string/indexOf | 3.06x slower | 1.44x faster | 2.27x slower |
| string/includes | 6.26x slower | 1.14x faster | 1.16x faster |
| string/split | 12.24x slower | 1.19x slower | — |
| string/replace | 2.57x slower | 1.90x faster | — |
| string/case-convert | 3.67x slower | 9.92x faster | — |
| string/substring | 2.78x faster | 3.23x faster | — |
| string/trim | 4.52x slower | 1.05x slower | — |
| string/startsWith-endsWith | 1.42x faster | 1.82x faster | 1.17x slower |
| array/push-pop | 3.14x faster | 3.22x faster | — |
| array/sort-i32 | 1.92x faster | 1.92x faster | — |
| array/map-filter | 1.69x faster | 1.72x faster | — |
| array/reduce | 3.03x faster | 2.72x faster | — |
| array/indexOf | 2.02x faster | 2.03x faster | — |
| array/slice | 1.25x slower | 1.01x faster | — |
| array/reverse | 2.24x faster | 2.23x faster | — |
| array/forEach | 3.88x faster | 3.28x faster | — |
| array/find | 36.50x faster | 37.11x faster | 1.96x slower |
| dom/create-elements | 3.61x slower | — | — |
| dom/set-attributes | 4.28x slower | — | — |
| dom/read-attributes | 2.08x slower | — | — |
| dom/modify-text | 2.54x slower | — | — |
| mixed/csv-parse | 14.98x slower | 1.30x faster | — |
| mixed/text-search | 2.89x slower | 1.68x faster | 2.63x slower |
| mixed/fibonacci | 1.58x slower | 1.58x slower | 1.58x slower |
| mixed/matrix-multiply | 1.02x slower | 1.18x slower | 3.70x slower |
| mixed/sieve | 1.03x slower | 1.04x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.12x slower |
| string/concat-long | 1.02x slower |
| string/indexOf | 4.41x faster |
| string/includes | 7.13x faster |
| string/split | 10.32x faster |
| string/replace | 4.89x faster |
| string/case-convert | 36.46x faster |
| string/substring | 1.17x faster |
| string/trim | 4.31x faster |
| string/startsWith-endsWith | 1.28x faster |
| array/push-pop | 1.02x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.02x faster |
| array/reduce | 1.11x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.26x faster |
| array/reverse | 1.01x slower |
| array/forEach | 1.18x slower |
| array/find | 1.02x faster |
| mixed/csv-parse | 19.46x faster |
| mixed/text-search | 4.85x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.16x slower |
| mixed/sieve | 1.02x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 731B | — |
| string/concat-long | 223B | 935B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.3KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.6KB | 3.1KB | — |
| array/map-filter | 3.3KB | 3.8KB | — |
| array/reduce | 2.3KB | 2.8KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.5KB | 3.1KB | — |
| array/find | 946B | 1.3KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.3KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 411B | 411B | 386B |
| mixed/matrix-multiply | 1.6KB | 2.0KB | 992B |
| mixed/sieve | 1.6KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1074.6ms | 908.5ms | — |
| string/concat-long | 541.8ms | 782.9ms | — |
| string/indexOf | 555.6ms | 809.2ms | 718.5ms |
| string/includes | 543.1ms | 795.7ms | 708.9ms |
| string/split | 633.1ms | 825.3ms | — |
| string/replace | 647.3ms | 883.9ms | — |
| string/case-convert | 669.1ms | 728.6ms | — |
| string/substring | 553.3ms | 629.7ms | — |
| string/trim | 651.8ms | 833.0ms | — |
| string/startsWith-endsWith | 667.6ms | 797.7ms | 744.3ms |
| array/push-pop | 646.3ms | 719.6ms | — |
| array/sort-i32 | 740.2ms | 839.1ms | — |
| array/map-filter | 757.6ms | 815.4ms | — |
| array/reduce | 710.5ms | 769.2ms | — |
| array/indexOf | 719.9ms | 764.3ms | — |
| array/slice | 629.6ms | 709.2ms | — |
| array/reverse | 649.8ms | 698.9ms | — |
| array/forEach | 743.5ms | 824.2ms | — |
| array/find | 645.4ms | 707.8ms | 700.6ms |
| dom/create-elements | 499.7ms | — | — |
| dom/set-attributes | 579.7ms | — | — |
| dom/read-attributes | 563.7ms | — | — |
| dom/modify-text | 487.9ms | — | — |
| mixed/csv-parse | 656.8ms | 780.9ms | — |
| mixed/text-search | 622.3ms | 837.6ms | 772.1ms |
| mixed/fibonacci | 631.0ms | 649.8ms | 673.9ms |
| mixed/matrix-multiply | 686.9ms | 769.9ms | 649.1ms |
| mixed/sieve | 689.7ms | 757.3ms | — |
