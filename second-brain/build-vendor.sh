#!/usr/bin/env bash
# vendor.js 재생성: 외부 라이브러리를 버전 고정해 하나의 ES 모듈로 묶는다.
set -euo pipefail
dir=$(mktemp -d)
out="$(cd "$(dirname "$0")" && pwd)/vendor.js"
cd "$dir"
npm init -y >/dev/null
npm i --silent \
  @supabase/supabase-js@2.45.4 marked@12.0.2 dompurify@3.1.6 d3-force@3.0.0 esbuild@0.24.0 \
  @codemirror/state@6.7.6 @codemirror/view@6.43.14 @codemirror/commands@6.11.1 \
  @codemirror/language@6.13.1 @codemirror/lang-markdown@6.5.2 @codemirror/autocomplete@6.20.3 \
  @codemirror/search@6.7.2 @lezer/markdown@1.8.0 @lezer/highlight@1.2.5
cat > entry.js <<'JS'
export { createClient } from '@supabase/supabase-js';
export { marked } from 'marked';
export { default as DOMPurify } from 'dompurify';
export { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, forceX, forceY } from 'd3-force';
export { EditorState, StateField, StateEffect, RangeSetBuilder, Compartment, Prec } from '@codemirror/state';
export { EditorView, keymap, Decoration, ViewPlugin, WidgetType, placeholder, drawSelection, highlightActiveLine, dropCursor } from '@codemirror/view';
export { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
export { syntaxTree, syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching } from '@codemirror/language';
export { markdown, markdownLanguage } from '@codemirror/lang-markdown';
export { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, startCompletion } from '@codemirror/autocomplete';
export { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
export { tags } from '@lezer/highlight';
JS
npx esbuild entry.js --bundle --format=esm --minify --platform=browser --legal-comments=eof --outfile="$out"
echo "wrote $out"
