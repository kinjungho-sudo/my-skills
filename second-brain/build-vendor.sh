#!/usr/bin/env bash
# vendor.js 재생성: 외부 라이브러리를 버전 고정해 하나의 ES 모듈로 묶는다.
set -euo pipefail
dir=$(mktemp -d)
out="$(cd "$(dirname "$0")" && pwd)/vendor.js"
cd "$dir"
npm init -y >/dev/null
npm i --silent @supabase/supabase-js@2.45.4 marked@12.0.2 dompurify@3.1.6 d3-force@3.0.0 esbuild@0.24.0
cat > entry.js <<'JS'
export { createClient } from '@supabase/supabase-js';
export { marked } from 'marked';
export { default as DOMPurify } from 'dompurify';
export { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from 'd3-force';
JS
npx esbuild entry.js --bundle --format=esm --minify --platform=browser --legal-comments=eof --outfile="$out"
echo "wrote $out"
