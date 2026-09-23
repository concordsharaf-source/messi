#!/usr/bin/env bash
# زيادة رقم الإصدار في كل الأماكن المطلوبة معاً (يُشغَّل قبل كل نشرة)
# الاستخدام:  bash tools/bump_build.sh 26
set -euo pipefail
NEW="${1:?رقم الإصدار الجديد مطلوب}"
cd "$(dirname "$0")/.."
OLD=$(grep -oE 'wa-clone-shell-v[0-9]+' sw.js | head -1 | grep -oE '[0-9]+')

sed -i "s/wa-clone-shell-v${OLD}/wa-clone-shell-v${NEW}/" sw.js
sed -i "s/\.\/css\/style\.css?v=${OLD}/.\/css\/style.css?v=${NEW}/" index.html
sed -i "s/\.\/js\/app\.js?v=${OLD}/.\/js\/app.js?v=${NEW}/" index.html
sed -i "s|\.\/vendor\/supabase-js\.js?v=${OLD}|./vendor/supabase-js.js?v=${NEW}|" index.html
sed -i "s/window.WA_BUILD = \"${OLD}\"/window.WA_BUILD = \"${NEW}\"/" index.html
sed -i "s/id=\"value-build\">v${OLD}/id=\"value-build\">v${NEW}/" index.html
sed -i "s/const BUILD = \"${OLD}\"/const BUILD = \"${NEW}\"/" js/app.js
python3 - "$NEW" <<'PY'
import json, sys, datetime, io
io.open('version.json','w',encoding='utf-8').write(json.dumps({"build": sys.argv[1], "date": datetime.date.today().isoformat()}) + "\n")
PY
echo "✔ الإصدار الآن v${NEW} (من v${OLD})"
grep -n "wa-clone-shell" sw.js | head -1
grep -n "BUILD = " js/app.js | head -1
grep -n "style.css?v=\|app.js?v=" index.html | head -2
