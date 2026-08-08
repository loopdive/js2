# js2wasm Benchmark Results

Date: 2026-08-08
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.044ms | 0.035ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.066ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.161ms | 0.023ms | FAILED | js |
| string/split | 0.412ms | 5.55ms | 0.449ms | FAILED | js |
| string/replace | 0.104ms | 0.311ms | 0.082ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.245ms | 0.110ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.903ms | 0.243ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 2.63ms | 0.286ms | FAILED | gc-native |
| array/push-pop | 1.45ms | 0.506ms | 0.501ms | FAILED | gc-native |
| array/sort-i32 | 0.791ms | 0.302ms | 0.300ms | FAILED | gc-native |
| array/map-filter | 0.126ms | 0.062ms | 0.062ms | FAILED | gc-native |
| array/reduce | 2.14ms | 0.502ms | 0.504ms | FAILED | host-call |
| array/indexOf | 3.95ms | 3.55ms | 3.55ms | FAILED | gc-native |
| array/slice | 0.025ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.048ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.238ms | 0.017ms | 0.017ms | 0.998ms | host-call |
| dom/create-elements | 0.182ms | 0.176ms | — | — | host-call |
| dom/set-attributes | 0.104ms | 0.607ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.147ms | — | — | js |
| dom/modify-text | 0.048ms | 0.140ms | — | — | js |
| mixed/csv-parse | 1.21ms | 8.33ms | 0.609ms | FAILED | gc-native |
| mixed/text-search | 0.389ms | 2.73ms | 0.328ms | FAILED | gc-native |
| mixed/fibonacci | 0.122ms | 0.118ms | 0.118ms | 0.044ms | linear-memory |
| mixed/matrix-multiply | 0.157ms | 0.191ms | 0.191ms | 0.720ms | js |
| mixed/sieve | 1.61ms | 1.40ms | 1.42ms | FAILED | host-call |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/includes | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/split | linear-memory | mid-loop | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/startsWith-endsWith | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/text-search | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 3.31 | 4.43 | 3.51 | — |
| string/concat-long | 1000 | 3.56 | 4.48 | 4.43 | — |
| string/indexOf | 1000 | 19.20 | 66.30 | 23.64 | — |
| string/includes | 1000 | 19.19 | 161.39 | 23.30 | — |
| string/split | 10000 | 41.17 | 554.58 | 44.93 | — |
| string/replace | 1000 | 104.29 | 310.51 | 81.88 | — |
| string/case-convert | 2000 | 27.85 | 122.42 | 55.12 | — |
| string/substring | 10000 | 9.87 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.02 | 90.30 | 24.32 | — |
| string/startsWith-endsWith | 20000 | 20.11 | 131.48 | 14.31 | — |
| array/map-filter | 30000 | 4.20 | 2.07 | 2.07 | — |
| array/indexOf | 1000 | 3948.63 | 3554.16 | 3550.00 | — |
| dom/create-elements | 2000 | 91.15 | 87.90 | — | — |
| dom/set-attributes | 6000 | 17.33 | 101.17 | — | — |
| dom/read-attributes | 3000 | 18.30 | 49.10 | — | — |
| dom/modify-text | 2000 | 24.22 | 69.97 | — | — |
| mixed/csv-parse | 11000 | 109.90 | 757.56 | 55.39 | — |
| mixed/text-search | 40000 | 9.71 | 68.13 | 8.20 | — |
| mixed/fibonacci | 10000 | 12.18 | 11.83 | 11.82 | 4.37 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.53 | 1.53 | 5.76 |
| mixed/sieve | 200000 | 8.03 | 6.99 | 7.09 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.34x slower | 1.06x slower | — |
| string/concat-long | 1.26x slower | 1.24x slower | — |
| string/indexOf | 3.45x slower | 1.23x slower | — |
| string/includes | 8.41x slower | 1.21x slower | — |
| string/split | 13.47x slower | 1.09x slower | — |
| string/replace | 2.98x slower | 1.27x faster | — |
| string/case-convert | 4.40x slower | 1.98x slower | — |
| string/substring | 2.64x faster | 3.21x faster | — |
| string/trim | 5.30x slower | 1.43x slower | — |
| string/startsWith-endsWith | 6.54x slower | 1.40x faster | — |
| array/push-pop | 2.86x faster | 2.89x faster | — |
| array/sort-i32 | 2.62x faster | 2.63x faster | — |
| array/map-filter | 2.02x faster | 2.03x faster | — |
| array/reduce | 4.26x faster | 4.24x faster | — |
| array/indexOf | 1.11x faster | 1.11x faster | — |
| array/slice | 1.08x slower | 1.08x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.74x faster | 1.73x faster | — |
| array/find | 14.35x faster | 14.31x faster | 4.19x slower |
| dom/create-elements | 1.04x faster | — | — |
| dom/set-attributes | 5.84x slower | — | — |
| dom/read-attributes | 2.68x slower | — | — |
| dom/modify-text | 2.89x slower | — | — |
| mixed/csv-parse | 6.89x slower | 1.98x faster | — |
| mixed/text-search | 7.01x slower | 1.18x faster | — |
| mixed/fibonacci | 1.03x faster | 1.03x faster | 2.79x faster |
| mixed/matrix-multiply | 1.21x slower | 1.21x slower | 4.57x slower |
| mixed/sieve | 1.15x faster | 1.13x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.26x faster |
| string/concat-long | 1.01x faster |
| string/indexOf | 2.80x faster |
| string/includes | 6.93x faster |
| string/split | 12.34x faster |
| string/replace | 3.79x faster |
| string/case-convert | 2.22x faster |
| string/substring | 1.22x faster |
| string/trim | 3.71x faster |
| string/startsWith-endsWith | 9.19x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x slower |
| array/find | 1.00x slower |
| mixed/csv-parse | 13.68x faster |
| mixed/text-search | 8.31x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.01x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 724B | — |
| string/concat-long | 223B | 954B | — |
| string/indexOf | 427B | 1.3KB | — |
| string/includes | 414B | 1.3KB | — |
| string/split | 1.5KB | 3.0KB | — |
| string/replace | 1.7KB | 4.1KB | — |
| string/case-convert | 1.6KB | 13.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.6KB | 3.5KB | — |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
| array/map-filter | 3.2KB | 3.5KB | — |
| array/reduce | 2.2KB | 2.5KB | — |
| array/indexOf | 1.1KB | 1.4KB | — |
| array/slice | 954B | 1.2KB | — |
| array/reverse | 932B | 1.2KB | — |
| array/forEach | 2.4KB | 2.8KB | — |
| array/find | 880B | 1.2KB | 635B |
| dom/create-elements | 230B | — | — |
| dom/set-attributes | 497B | — | — |
| dom/read-attributes | 347B | — | — |
| dom/modify-text | 237B | — | — |
| mixed/csv-parse | 2.2KB | 4.6KB | — |
| mixed/text-search | 1.8KB | 4.0KB | — |
| mixed/fibonacci | 263B | 263B | 251B |
| mixed/matrix-multiply | 1.5KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1321.6ms | 1096.0ms | — |
| string/concat-long | 622.2ms | 951.9ms | — |
| string/indexOf | 764.9ms | 1005.8ms | — |
| string/includes | 761.6ms | 996.5ms | — |
| string/split | 721.3ms | 956.5ms | — |
| string/replace | 813.8ms | 1073.8ms | — |
| string/case-convert | 791.9ms | 1060.7ms | — |
| string/substring | 628.8ms | 698.4ms | — |
| string/trim | 699.2ms | 1013.7ms | — |
| string/startsWith-endsWith | 733.3ms | 961.1ms | — |
| array/push-pop | 749.6ms | 847.7ms | — |
| array/sort-i32 | 943.2ms | 986.6ms | — |
| array/map-filter | 886.4ms | 991.5ms | — |
| array/reduce | 823.9ms | 886.3ms | — |
| array/indexOf | 817.0ms | 896.0ms | — |
| array/slice | 756.3ms | 855.2ms | — |
| array/reverse | 751.1ms | 821.6ms | — |
| array/forEach | 862.8ms | 902.0ms | — |
| array/find | 716.2ms | 779.5ms | 808.5ms |
| dom/create-elements | 657.4ms | — | — |
| dom/set-attributes | 694.5ms | — | — |
| dom/read-attributes | 695.7ms | — | — |
| dom/modify-text | 661.8ms | — | — |
| mixed/csv-parse | 783.5ms | 984.2ms | — |
| mixed/text-search | 743.8ms | 1030.2ms | — |
| mixed/fibonacci | 794.6ms | 808.1ms | 721.2ms |
| mixed/matrix-multiply | 813.9ms | 866.3ms | 785.2ms |
| mixed/sieve | 826.2ms | 866.2ms | — |
