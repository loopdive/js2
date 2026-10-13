# js2wasm Benchmark Results

Date: 2026-10-13
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.048ms | 0.042ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.122ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.412ms | 8.39ms | 2.79ms | FAILED | js |
| string/replace | 0.110ms | 0.698ms | 0.342ms | FAILED | js |
| string/case-convert | 0.057ms | 0.582ms | 0.270ms | FAILED | js |
| string/substring | 0.098ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.87ms | 2.86ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 2.85ms | 3.04ms | 0.563ms | js |
| array/push-pop | 1.40ms | 0.498ms | 0.501ms | FAILED | host-call |
| array/sort-i32 | 0.795ms | 0.294ms | 0.293ms | FAILED | gc-native |
| array/map-filter | 0.128ms | 0.070ms | 0.070ms | FAILED | gc-native |
| array/reduce | 2.13ms | 0.503ms | 0.504ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.65ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.025ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.087ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.254ms | 0.016ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.040ms | 0.100ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.219ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.130ms | — | — | js |
| dom/modify-text | 0.030ms | 0.132ms | — | — | js |
| mixed/csv-parse | 0.482ms | 8.70ms | 0.628ms | FAILED | js |
| mixed/text-search | 0.389ms | 5.26ms | 2.92ms | 1.09ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.284ms | 0.281ms | js |
| mixed/matrix-multiply | 0.158ms | 76.07ms | 77.06ms | 0.716ms | js |
| mixed/sieve | 1.54ms | 2.11ms | 2.12ms | FAILED | js |

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
| string/concat-short | 10000 | 3.26 | 4.83 | 4.23 | — |
| string/concat-long | 1000 | 3.57 | 4.58 | 3.51 | — |
| string/indexOf | 1000 | 19.16 | 63.81 | 12.05 | 14.77 |
| string/includes | 1000 | 19.20 | 121.52 | 14.76 | 15.39 |
| string/split | 10000 | 41.22 | 839.22 | 278.65 | — |
| string/replace | 1000 | 109.84 | 698.40 | 342.48 | — |
| string/case-convert | 2000 | 28.37 | 290.83 | 135.10 | — |
| string/substring | 10000 | 9.85 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.02 | 387.12 | 286.43 | — |
| string/startsWith-endsWith | 20000 | 20.11 | 142.38 | 151.98 | 28.17 |
| array/map-filter | 30000 | 4.27 | 2.34 | 2.34 | — |
| array/indexOf | 1000 | 3952.35 | 2646.08 | 2643.09 | — |
| dom/create-elements | 2000 | 20.19 | 50.22 | — | — |
| dom/set-attributes | 6000 | 17.24 | 36.51 | — | — |
| dom/read-attributes | 3000 | 18.48 | 43.30 | — | — |
| dom/modify-text | 2000 | 14.85 | 65.95 | — | — |
| mixed/csv-parse | 11000 | 43.83 | 791.16 | 57.10 | — |
| mixed/text-search | 40000 | 9.72 | 131.45 | 72.96 | 27.16 |
| mixed/fibonacci | 10000 | 12.02 | 28.31 | 28.37 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.26 | 608.57 | 616.49 | 5.73 |
| mixed/sieve | 200000 | 7.68 | 10.55 | 10.62 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.48x slower | 1.30x slower | — |
| string/concat-long | 1.28x slower | 1.02x faster | — |
| string/indexOf | 3.33x slower | 1.59x faster | 1.30x faster |
| string/includes | 6.33x slower | 1.30x faster | 1.25x faster |
| string/split | 20.36x slower | 6.76x slower | — |
| string/replace | 6.36x slower | 3.12x slower | — |
| string/case-convert | 10.25x slower | 4.76x slower | — |
| string/substring | 2.63x faster | 3.21x faster | — |
| string/trim | 22.74x slower | 16.83x slower | — |
| string/startsWith-endsWith | 7.08x slower | 7.56x slower | 1.40x slower |
| array/push-pop | 2.81x faster | 2.79x faster | — |
| array/sort-i32 | 2.71x faster | 2.72x faster | — |
| array/map-filter | 1.82x faster | 1.82x faster | — |
| array/reduce | 4.24x faster | 4.24x faster | — |
| array/indexOf | 1.49x faster | 1.50x faster | — |
| array/slice | 1.08x slower | 1.08x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 3.11x faster | 3.09x faster | — |
| array/find | 15.57x faster | 15.98x faster | 4.25x slower |
| dom/create-elements | 2.49x slower | — | — |
| dom/set-attributes | 2.12x slower | — | — |
| dom/read-attributes | 2.34x slower | — | — |
| dom/modify-text | 4.44x slower | — | — |
| mixed/csv-parse | 18.05x slower | 1.30x slower | — |
| mixed/text-search | 13.52x slower | 7.50x slower | 2.79x slower |
| mixed/fibonacci | 2.36x slower | 2.36x slower | 2.34x slower |
| mixed/matrix-multiply | 482.00x slower | 488.27x slower | 4.54x slower |
| mixed/sieve | 1.37x slower | 1.38x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.14x faster |
| string/concat-long | 1.31x faster |
| string/indexOf | 5.30x faster |
| string/includes | 8.23x faster |
| string/split | 3.01x faster |
| string/replace | 2.04x faster |
| string/case-convert | 2.15x faster |
| string/substring | 1.22x faster |
| string/trim | 1.35x faster |
| string/startsWith-endsWith | 1.07x slower |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.01x slower |
| array/find | 1.03x faster |
| mixed/csv-parse | 13.86x faster |
| mixed/text-search | 1.80x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.01x slower |
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
| string/concat-short | 1153.6ms | 617.3ms | — |
| string/concat-long | 433.3ms | 639.1ms | — |
| string/indexOf | 366.4ms | 660.4ms | 537.3ms |
| string/includes | 365.7ms | 694.6ms | 564.1ms |
| string/split | 528.2ms | 703.8ms | — |
| string/replace | 496.3ms | 741.7ms | — |
| string/case-convert | 527.6ms | 593.8ms | — |
| string/substring | 397.3ms | 453.6ms | — |
| string/trim | 481.9ms | 681.8ms | — |
| string/startsWith-endsWith | 475.8ms | 711.0ms | 624.1ms |
| array/push-pop | 529.1ms | 568.4ms | — |
| array/sort-i32 | 672.9ms | 703.0ms | — |
| array/map-filter | 680.8ms | 729.2ms | — |
| array/reduce | 616.3ms | 677.1ms | — |
| array/indexOf | 593.9ms | 659.8ms | — |
| array/slice | 507.6ms | 575.1ms | — |
| array/reverse | 514.0ms | 572.2ms | — |
| array/forEach | 634.0ms | 677.8ms | — |
| array/find | 492.3ms | 592.0ms | 529.1ms |
| dom/create-elements | 410.7ms | — | — |
| dom/set-attributes | 379.2ms | — | — |
| dom/read-attributes | 380.3ms | — | — |
| dom/modify-text | 375.5ms | — | — |
| mixed/csv-parse | 515.8ms | 673.8ms | — |
| mixed/text-search | 509.4ms | 699.7ms | 622.4ms |
| mixed/fibonacci | 457.2ms | 486.9ms | 486.4ms |
| mixed/matrix-multiply | 648.8ms | 676.1ms | 513.8ms |
| mixed/sieve | 630.1ms | 665.6ms | — |
