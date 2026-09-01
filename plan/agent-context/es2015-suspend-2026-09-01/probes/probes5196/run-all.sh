#!/bin/bash
cd /home/user/js2
out=.tmp/es2015/probes5196/probes-run1.txt
: > $out
for f in .tmp/es2015/probes5196/p*.js; do
  echo "=== $f" >> $out
  timeout 300 npx tsx .tmp/probe-one.mts "$PWD/$f" >> $out 2>&1
  echo "exit=$?" >> $out
done
echo "PROBES DONE" >> $out
# compile-timeout rows alone
printf 'built-ins/Proxy/setPrototypeOf/not-extensible-target-same-target-prototype.js\nbuilt-ins/Proxy/apply/null-handler-realm.js\n' > .tmp/es2015/proxy-timeouts.txt
npx tsx scripts/run-test262-paths.mts .tmp/es2015/proxy-timeouts.txt --standalone > .tmp/es2015/proxy-timeouts-run.txt 2>&1
echo "exit=$?" >> .tmp/es2015/proxy-timeouts-run.txt
# controls
npx tsx scripts/run-test262-paths.mts .tmp/es2015/proxy-controls.txt --standalone > .tmp/es2015/proxy-controls-run1.txt 2>&1
echo "exit=$?" >> .tmp/es2015/proxy-controls-run1.txt
