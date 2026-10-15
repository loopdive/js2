# js2wasm Benchmark Results

Date: 2026-10-14
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.037ms | 0.048ms | 0.046ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.020ms | 0.114ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.423ms | 8.30ms | 2.89ms | FAILED | js |
| string/replace | 0.102ms | 0.702ms | 0.320ms | FAILED | js |
| string/case-convert | 0.056ms | 0.649ms | 0.267ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.221ms | 3.99ms | 2.86ms | FAILED | js |
| string/startsWith-endsWith | 0.400ms | 2.95ms | 3.01ms | 0.562ms | js |
| array/push-pop | 1.40ms | 0.500ms | 0.504ms | FAILED | host-call |
| array/sort-i32 | 0.793ms | 0.293ms | 0.294ms | FAILED | host-call |
| array/map-filter | 0.127ms | 0.070ms | 0.070ms | FAILED | gc-native |
| array/reduce | 1.35ms | 0.504ms | 0.509ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.65ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.025ms | 0.029ms | 0.027ms | FAILED | js |
| array/reverse | 7.84ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.086ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.255ms | 0.016ms | 0.016ms | 1.08ms | host-call |
| dom/create-elements | 0.042ms | 0.101ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.224ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.128ms | — | — | js |
| dom/modify-text | 0.030ms | 0.107ms | — | — | js |
| mixed/csv-parse | 1.53ms | 9.00ms | 0.646ms | FAILED | gc-native |
| mixed/text-search | 0.390ms | 5.08ms | 2.95ms | 1.09ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.158ms | 82.95ms | 84.96ms | 0.716ms | js |
| mixed/sieve | 1.54ms | 2.11ms | 2.10ms | FAILED | js |

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
| string/concat-short | 10000 | 3.71 | 4.80 | 4.57 | — |
| string/concat-long | 1000 | 3.67 | 4.60 | 3.61 | — |
| string/indexOf | 1000 | 19.48 | 64.04 | 11.99 | 14.64 |
| string/includes | 1000 | 19.51 | 113.72 | 14.70 | 15.45 |
| string/split | 10000 | 42.32 | 829.80 | 288.95 | — |
| string/replace | 1000 | 101.97 | 701.75 | 320.26 | — |
| string/case-convert | 2000 | 27.82 | 324.31 | 133.65 | — |
| string/substring | 10000 | 9.88 | 3.74 | 3.07 | — |
| string/trim | 10000 | 22.13 | 398.85 | 285.55 | — |
| string/startsWith-endsWith | 20000 | 20.02 | 147.56 | 150.59 | 28.08 |
| array/map-filter | 30000 | 4.22 | 2.35 | 2.35 | — |
| array/indexOf | 1000 | 3949.97 | 2645.03 | 2642.97 | — |
| dom/create-elements | 2000 | 20.77 | 50.36 | — | — |
| dom/set-attributes | 6000 | 17.22 | 37.26 | — | — |
| dom/read-attributes | 3000 | 18.71 | 42.68 | — | — |
| dom/modify-text | 2000 | 14.76 | 53.40 | — | — |
| mixed/csv-parse | 11000 | 139.41 | 818.28 | 58.72 | — |
| mixed/text-search | 40000 | 9.75 | 127.10 | 73.83 | 27.20 |
| mixed/fibonacci | 10000 | 12.01 | 28.30 | 28.31 | 28.07 |
| mixed/matrix-multiply | 125000 | 1.26 | 663.60 | 679.66 | 5.72 |
| mixed/sieve | 200000 | 7.68 | 10.56 | 10.50 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.29x slower | 1.23x slower | — |
| string/concat-long | 1.25x slower | 1.02x faster | — |
| string/indexOf | 3.29x slower | 1.62x faster | 1.33x faster |
| string/includes | 5.83x slower | 1.33x faster | 1.26x faster |
| string/split | 19.61x slower | 6.83x slower | — |
| string/replace | 6.88x slower | 3.14x slower | — |
| string/case-convert | 11.66x slower | 4.80x slower | — |
| string/substring | 2.64x faster | 3.22x faster | — |
| string/trim | 18.02x slower | 12.90x slower | — |
| string/startsWith-endsWith | 7.37x slower | 7.52x slower | 1.40x slower |
| array/push-pop | 2.81x faster | 2.78x faster | — |
| array/sort-i32 | 2.71x faster | 2.70x faster | — |
| array/map-filter | 1.80x faster | 1.80x faster | — |
| array/reduce | 2.68x faster | 2.65x faster | — |
| array/indexOf | 1.49x faster | 1.49x faster | — |
| array/slice | 1.17x slower | 1.09x slower | — |
| array/reverse | 2.23x faster | 2.22x faster | — |
| array/forEach | 3.09x faster | 3.09x faster | — |
| array/find | 16.16x faster | 16.06x faster | 4.24x slower |
| dom/create-elements | 2.42x slower | — | — |
| dom/set-attributes | 2.16x slower | — | — |
| dom/read-attributes | 2.28x slower | — | — |
| dom/modify-text | 3.62x slower | — | — |
| mixed/csv-parse | 5.87x slower | 2.37x faster | — |
| mixed/text-search | 13.03x slower | 7.57x slower | 2.79x slower |
| mixed/fibonacci | 2.36x slower | 2.36x slower | 2.34x slower |
| mixed/matrix-multiply | 525.55x slower | 538.27x slower | 4.53x slower |
| mixed/sieve | 1.37x slower | 1.37x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.05x faster |
| string/concat-long | 1.28x faster |
| string/indexOf | 5.34x faster |
| string/includes | 7.74x faster |
| string/split | 2.87x faster |
| string/replace | 2.19x faster |
| string/case-convert | 2.43x faster |
| string/substring | 1.22x faster |
| string/trim | 1.40x faster |
| string/startsWith-endsWith | 1.02x slower |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.07x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 13.94x faster |
| mixed/text-search | 1.72x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.02x slower |
| mixed/sieve | 1.01x faster |

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
| string/concat-short | 1141.0ms | 610.9ms | — |
| string/concat-long | 452.6ms | 650.3ms | — |
| string/indexOf | 374.9ms | 659.3ms | 545.7ms |
| string/includes | 377.4ms | 658.2ms | 563.0ms |
| string/split | 504.5ms | 688.5ms | — |
| string/replace | 507.1ms | 716.1ms | — |
| string/case-convert | 516.2ms | 616.8ms | — |
| string/substring | 378.7ms | 460.3ms | — |
| string/trim | 487.2ms | 688.2ms | — |
| string/startsWith-endsWith | 498.4ms | 678.1ms | 608.4ms |
| array/push-pop | 510.1ms | 572.5ms | — |
| array/sort-i32 | 684.1ms | 721.9ms | — |
| array/map-filter | 659.5ms | 759.9ms | — |
| array/reduce | 623.8ms | 686.4ms | — |
| array/indexOf | 609.3ms | 658.9ms | — |
| array/slice | 508.7ms | 602.4ms | — |
| array/reverse | 500.2ms | 578.3ms | — |
| array/forEach | 632.1ms | 688.5ms | — |
| array/find | 475.1ms | 614.4ms | 552.3ms |
| dom/create-elements | 412.9ms | — | — |
| dom/set-attributes | 370.5ms | — | — |
| dom/read-attributes | 387.2ms | — | — |
| dom/modify-text | 369.4ms | — | — |
| mixed/csv-parse | 526.9ms | 670.8ms | — |
| mixed/text-search | 494.6ms | 696.6ms | 609.1ms |
| mixed/fibonacci | 458.1ms | 497.3ms | 460.8ms |
| mixed/matrix-multiply | 629.6ms | 701.3ms | 502.3ms |
| mixed/sieve | 623.8ms | 664.2ms | — |
