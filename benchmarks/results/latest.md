# js2wasm Benchmark Results

Date: 2026-10-09
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.046ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.066ms | 0.012ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.117ms | 0.015ms | 0.016ms | gc-native |
| string/split | 0.427ms | 8.46ms | 2.85ms | FAILED | js |
| string/replace | 0.101ms | 0.698ms | 0.322ms | FAILED | js |
| string/case-convert | 0.056ms | 0.640ms | 0.265ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.99ms | 2.83ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 3.08ms | 3.15ms | 0.561ms | js |
| array/push-pop | 1.38ms | 0.500ms | 0.501ms | FAILED | host-call |
| array/sort-i32 | 0.788ms | 0.294ms | 0.294ms | FAILED | host-call |
| array/map-filter | 0.126ms | 0.070ms | 0.070ms | FAILED | gc-native |
| array/reduce | 2.14ms | 0.501ms | 0.504ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.026ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.84ms | 3.53ms | 3.53ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.254ms | 0.016ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.041ms | 0.173ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.222ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.134ms | — | — | js |
| dom/modify-text | 0.029ms | 0.106ms | — | — | js |
| mixed/csv-parse | 0.507ms | 8.79ms | 0.639ms | FAILED | js |
| mixed/text-search | 0.390ms | 5.15ms | 2.93ms | 1.08ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.288ms | js |
| mixed/matrix-multiply | 0.163ms | 75.43ms | 77.02ms | 0.720ms | js |
| mixed/sieve | 1.57ms | 2.10ms | 2.10ms | FAILED | js |

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
| string/concat-short | 10000 | 3.36 | 4.65 | 4.41 | — |
| string/concat-long | 1000 | 3.59 | 4.47 | 3.57 | — |
| string/indexOf | 1000 | 19.11 | 66.50 | 12.26 | 15.75 |
| string/includes | 1000 | 19.21 | 116.61 | 14.78 | 16.08 |
| string/split | 10000 | 42.71 | 846.10 | 285.14 | — |
| string/replace | 1000 | 101.29 | 698.27 | 321.97 | — |
| string/case-convert | 2000 | 27.80 | 319.89 | 132.64 | — |
| string/substring | 10000 | 9.87 | 3.74 | 3.07 | — |
| string/trim | 10000 | 16.97 | 399.13 | 282.93 | — |
| string/startsWith-endsWith | 20000 | 20.07 | 154.03 | 157.63 | 28.03 |
| array/map-filter | 30000 | 4.18 | 2.33 | 2.32 | — |
| array/indexOf | 1000 | 3948.99 | 2643.54 | 2642.59 | — |
| dom/create-elements | 2000 | 20.61 | 86.68 | — | — |
| dom/set-attributes | 6000 | 17.39 | 36.98 | — | — |
| dom/read-attributes | 3000 | 18.45 | 44.59 | — | — |
| dom/modify-text | 2000 | 14.69 | 53.15 | — | — |
| mixed/csv-parse | 11000 | 46.05 | 799.10 | 58.06 | — |
| mixed/text-search | 40000 | 9.74 | 128.73 | 73.22 | 27.09 |
| mixed/fibonacci | 10000 | 12.02 | 28.32 | 28.31 | 28.79 |
| mixed/matrix-multiply | 125000 | 1.30 | 603.42 | 616.15 | 5.76 |
| mixed/sieve | 200000 | 7.83 | 10.51 | 10.50 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.38x slower | 1.31x slower | — |
| string/concat-long | 1.24x slower | 1.01x faster | — |
| string/indexOf | 3.48x slower | 1.56x faster | 1.21x faster |
| string/includes | 6.07x slower | 1.30x faster | 1.19x faster |
| string/split | 19.81x slower | 6.68x slower | — |
| string/replace | 6.89x slower | 3.18x slower | — |
| string/case-convert | 11.51x slower | 4.77x slower | — |
| string/substring | 2.64x faster | 3.21x faster | — |
| string/trim | 23.52x slower | 16.67x slower | — |
| string/startsWith-endsWith | 7.67x slower | 7.85x slower | 1.40x slower |
| array/push-pop | 2.76x faster | 2.75x faster | — |
| array/sort-i32 | 2.69x faster | 2.68x faster | — |
| array/map-filter | 1.80x faster | 1.80x faster | — |
| array/reduce | 4.26x faster | 4.24x faster | — |
| array/indexOf | 1.49x faster | 1.49x faster | — |
| array/slice | 1.06x slower | 1.08x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.77x faster | 1.78x faster | — |
| array/find | 15.99x faster | 16.13x faster | 4.25x slower |
| dom/create-elements | 4.21x slower | — | — |
| dom/set-attributes | 2.13x slower | — | — |
| dom/read-attributes | 2.42x slower | — | — |
| dom/modify-text | 3.62x slower | — | — |
| mixed/csv-parse | 17.35x slower | 1.26x slower | — |
| mixed/text-search | 13.22x slower | 7.52x slower | 2.78x slower |
| mixed/fibonacci | 2.36x slower | 2.36x slower | 2.40x slower |
| mixed/matrix-multiply | 462.63x slower | 472.39x slower | 4.42x slower |
| mixed/sieve | 1.34x slower | 1.34x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.05x faster |
| string/concat-long | 1.25x faster |
| string/indexOf | 5.42x faster |
| string/includes | 7.89x faster |
| string/split | 2.97x faster |
| string/replace | 2.17x faster |
| string/case-convert | 2.41x faster |
| string/substring | 1.22x faster |
| string/trim | 1.41x faster |
| string/startsWith-endsWith | 1.02x slower |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 13.76x faster |
| mixed/text-search | 1.76x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.02x slower |
| mixed/sieve | 1.00x faster |

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
| string/concat-short | 1163.3ms | 657.9ms | — |
| string/concat-long | 427.2ms | 633.5ms | — |
| string/indexOf | 365.6ms | 665.1ms | 536.0ms |
| string/includes | 367.1ms | 662.0ms | 568.2ms |
| string/split | 508.2ms | 681.8ms | — |
| string/replace | 502.5ms | 762.8ms | — |
| string/case-convert | 511.2ms | 621.4ms | — |
| string/substring | 380.7ms | 452.7ms | — |
| string/trim | 491.5ms | 672.3ms | — |
| string/startsWith-endsWith | 495.1ms | 674.9ms | 612.9ms |
| array/push-pop | 507.8ms | 587.0ms | — |
| array/sort-i32 | 648.4ms | 732.1ms | — |
| array/map-filter | 706.2ms | 752.0ms | — |
| array/reduce | 602.9ms | 701.1ms | — |
| array/indexOf | 575.9ms | 656.8ms | — |
| array/slice | 543.6ms | 608.9ms | — |
| array/reverse | 502.3ms | 583.8ms | — |
| array/forEach | 694.0ms | 721.8ms | — |
| array/find | 513.0ms | 591.7ms | 563.4ms |
| dom/create-elements | 419.8ms | — | — |
| dom/set-attributes | 388.4ms | — | — |
| dom/read-attributes | 386.0ms | — | — |
| dom/modify-text | 372.6ms | — | — |
| mixed/csv-parse | 537.2ms | 685.5ms | — |
| mixed/text-search | 511.0ms | 698.7ms | 629.7ms |
| mixed/fibonacci | 458.7ms | 503.3ms | 487.6ms |
| mixed/matrix-multiply | 638.5ms | 699.9ms | 514.4ms |
| mixed/sieve | 611.4ms | 665.1ms | — |
