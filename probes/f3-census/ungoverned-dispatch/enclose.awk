# annotate matching lines with the nearest preceding top-level/method function header
/^(export )?(async )?function [A-Za-z_$][A-Za-z0-9_$]*/ { match($0,/function [A-Za-z_$][A-Za-z0-9_$]*/); fn=substr($0,RSTART+9,RLENGTH-9); mline=NR }
/^  (async )?[A-Za-z_$][A-Za-z0-9_$]*\(.*\)( *:.*)? *\{ *$/ { match($0,/[A-Za-z_$][A-Za-z0-9_$]*\(/); meth=substr($0,RSTART,RLENGTH-1); mline2=NR }
/^  (readonly )?[A-Za-z_$][A-Za-z0-9_$]*: *(async )?\(/ { match($0,/[A-Za-z_$][A-Za-z0-9_$]*:/); meth=substr($0,RSTART,RLENGTH-1); mline2=NR }
/^(export )?const [A-Za-z_$][A-Za-z0-9_$]* *= *(async )?\(/ { match($0,/const [A-Za-z_$][A-Za-z0-9_$]*/); fn=substr($0,RSTART+6,RLENGTH-6); mline=NR }
$0 ~ PAT && $0 !~ /^[ \t]*(\/\/|\*|\/\*)/ { m=(mline2>mline)?meth:fn; printf "%s:%d [%s] %s\n", FILE, NR, m, $0 }
