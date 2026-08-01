# js2wasm Benchmark Results

Date: 2026-08-01
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.045ms | 0.037ms | FAILED | js |
| string/concat-long | 0.004ms | 0.007ms | 0.008ms | FAILED | js |
| string/indexOf | 0.019ms | 0.084ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.150ms | 0.022ms | FAILED | js |
| string/split | 0.412ms | 5.95ms | 1.42ms | FAILED | js |
| string/replace | 0.047ms | 0.298ms | 0.101ms | FAILED | js |
| string/case-convert | 0.060ms | 0.243ms | 0.106ms | FAILED | js |
| string/substring | 0.099ms | 1.91ms | 0.904ms | FAILED | js |
| string/trim | 0.169ms | 1.42ms | 0.642ms | FAILED | js |
| string/startsWith-endsWith | 0.390ms | 2.88ms | 0.520ms | FAILED | js |
| array/push-pop | 1.41ms | 2.15ms | 2.16ms | FAILED | js |
| array/sort-i32 | 0.787ms | 0.402ms | 0.389ms | FAILED | gc-native |
| array/map-filter | 0.125ms | 0.642ms | 0.641ms | FAILED | js |
| array/reduce | 2.13ms | 2.17ms | 2.15ms | FAILED | js |
| array/indexOf | 3.94ms | 3.42ms | 3.42ms | FAILED | host-call |
| array/slice | 0.024ms | 0.033ms | 0.034ms | FAILED | js |
| array/reverse | 7.82ms | 3.43ms | 3.43ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.114ms | 0.115ms | FAILED | js |
| array/find | 0.238ms | 0.458ms | 0.458ms | 4.84ms | js |
| dom/create-elements | 0.212ms | 0.302ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.364ms | — | — | js |
| dom/read-attributes | 0.054ms | 0.171ms | — | — | js |
| dom/modify-text | 0.049ms | 0.162ms | — | — | js |
| mixed/csv-parse | 0.475ms | 7.32ms | 0.825ms | FAILED | js |
| mixed/text-search | 0.391ms | 6.49ms | 1.06ms | FAILED | js |
| mixed/fibonacci | 0.122ms | 0.261ms | 0.261ms | 0.259ms | js |
| mixed/matrix-multiply | 0.156ms | 0.555ms | 0.555ms | 2.12ms | js |
| mixed/sieve | 1.54ms | 1.39ms | 1.39ms | FAILED | gc-native |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/includes | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/split | linear-memory | warmup | memory access out of bounds |
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
| string/concat-short | 10000 | 3.31 | 4.50 | 3.69 | — |
| string/concat-long | 1000 | 3.55 | 7.48 | 8.16 | — |
| string/indexOf | 1000 | 19.13 | 83.99 | 23.57 | — |
| string/includes | 1000 | 19.15 | 149.55 | 22.49 | — |
| string/split | 10000 | 41.21 | 595.18 | 141.83 | — |
| string/replace | 1000 | 46.53 | 298.30 | 100.69 | — |
| string/case-convert | 2000 | 30.16 | 121.37 | 52.88 | — |
| string/substring | 10000 | 9.86 | 190.81 | 90.42 | — |
| string/trim | 10000 | 16.90 | 141.86 | 64.18 | — |
| string/startsWith-endsWith | 20000 | 19.51 | 143.85 | 25.98 | — |
| mixed/csv-parse | 11000 | 43.22 | 665.26 | 75.00 | — |
| mixed/text-search | 40000 | 9.78 | 162.22 | 26.59 | — |
| mixed/fibonacci | 10000 | 12.17 | 26.11 | 26.12 | 25.90 |
| mixed/matrix-multiply | 125000 | 1.25 | 4.44 | 4.44 | 16.97 |
| mixed/sieve | 200000 | 7.71 | 6.94 | 6.93 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.36x slower | 1.12x slower | — |
| string/concat-long | 2.11x slower | 2.30x slower | — |
| string/indexOf | 4.39x slower | 1.23x slower | — |
| string/includes | 7.81x slower | 1.17x slower | — |
| string/split | 14.44x slower | 3.44x slower | — |
| string/replace | 6.41x slower | 2.16x slower | — |
| string/case-convert | 4.02x slower | 1.75x slower | — |
| string/substring | 19.35x slower | 9.17x slower | — |
| string/trim | 8.39x slower | 3.80x slower | — |
| string/startsWith-endsWith | 7.37x slower | 1.33x slower | — |
| array/push-pop | 1.52x slower | 1.53x slower | — |
| array/sort-i32 | 1.96x faster | 2.02x faster | — |
| array/map-filter | 5.14x slower | 5.14x slower | — |
| array/reduce | 1.02x slower | 1.01x slower | — |
| array/indexOf | 1.15x faster | 1.15x faster | — |
| array/slice | 1.40x slower | 1.41x slower | — |
| array/reverse | 2.28x faster | 2.28x faster | — |
| array/forEach | 2.33x slower | 2.34x slower | — |
| array/find | 1.92x slower | 1.92x slower | 20.33x slower |
| dom/create-elements | 1.42x slower | — | — |
| dom/set-attributes | 3.51x slower | — | — |
| dom/read-attributes | 3.16x slower | — | — |
| dom/modify-text | 3.34x slower | — | — |
| mixed/csv-parse | 15.39x slower | 1.74x slower | — |
| mixed/text-search | 16.59x slower | 2.72x slower | — |
| mixed/fibonacci | 2.15x slower | 2.15x slower | 2.13x slower |
| mixed/matrix-multiply | 3.55x slower | 3.55x slower | 13.59x slower |
| mixed/sieve | 1.11x faster | 1.11x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.22x faster |
| string/concat-long | 1.09x slower |
| string/indexOf | 3.56x faster |
| string/includes | 6.65x faster |
| string/split | 4.20x faster |
| string/replace | 2.96x faster |
| string/case-convert | 2.30x faster |
| string/substring | 2.11x faster |
| string/trim | 2.21x faster |
| string/startsWith-endsWith | 5.54x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.03x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.01x slower |
| array/find | 1.00x slower |
| mixed/csv-parse | 8.87x faster |
| mixed/text-search | 6.10x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.00x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 1.7KB | — |
| string/concat-long | 233B | 1.9KB | — |
| string/indexOf | 412B | 2.3KB | — |
| string/includes | 398B | 2.3KB | — |
| string/split | 1.7KB | 3.4KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.4KB | 13.1KB | — |
| string/substring | 556B | 2.0KB | — |
| string/trim | 1.4KB | 2.8KB | — |
| string/startsWith-endsWith | 1.8KB | 3.7KB | — |
| array/push-pop | 956B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
| array/map-filter | 3.3KB | 3.6KB | — |
| array/reduce | 2.3KB | 2.6KB | — |
| array/indexOf | 1.0KB | 1.3KB | — |
| array/slice | 1.0KB | 1.3KB | — |
| array/reverse | 1020B | 1.3KB | — |
| array/forEach | 2.6KB | 2.9KB | — |
| array/find | 2.7KB | 3.0KB | 623B |
| dom/create-elements | 240B | — | — |
| dom/set-attributes | 507B | — | — |
| dom/read-attributes | 357B | — | — |
| dom/modify-text | 247B | — | — |
| mixed/csv-parse | 2.2KB | 4.4KB | — |
| mixed/text-search | 2.0KB | 4.4KB | — |
| mixed/fibonacci | 297B | 1.3KB | 313B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 950B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1263.6ms | 1137.9ms | — |
| string/concat-long | 605.7ms | 973.6ms | — |
| string/indexOf | 760.8ms | 1021.0ms | — |
| string/includes | 723.6ms | 990.0ms | — |
| string/split | 796.7ms | 1017.7ms | — |
| string/replace | 774.1ms | 1066.9ms | — |
| string/case-convert | 789.0ms | 1154.2ms | — |
| string/substring | 684.4ms | 913.4ms | — |
| string/trim | 785.1ms | 1008.9ms | — |
| string/startsWith-endsWith | 786.2ms | 982.5ms | — |
| array/push-pop | 734.9ms | 794.2ms | — |
| array/sort-i32 | 905.1ms | 950.1ms | — |
| array/map-filter | 924.4ms | 974.0ms | — |
| array/reduce | 841.0ms | 889.5ms | — |
| array/indexOf | 763.5ms | 802.1ms | — |
| array/slice | 746.6ms | 839.0ms | — |
| array/reverse | 749.9ms | 822.6ms | — |
| array/forEach | 862.9ms | 941.6ms | — |
| array/find | 855.8ms | 967.1ms | 806.6ms |
| dom/create-elements | 641.8ms | — | — |
| dom/set-attributes | 700.4ms | — | — |
| dom/read-attributes | 655.7ms | — | — |
| dom/modify-text | 680.4ms | — | — |
| mixed/csv-parse | 853.6ms | 994.6ms | — |
| mixed/text-search | 807.7ms | 972.7ms | — |
| mixed/fibonacci | 781.0ms | 854.5ms | 767.9ms |
| mixed/matrix-multiply | 856.8ms | 915.0ms | 759.9ms |
| mixed/sieve | 776.1ms | 878.4ms | — |
