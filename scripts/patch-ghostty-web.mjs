import { readFileSync, writeFileSync } from 'node:fs'

const files = [
  'node_modules/ghostty-web/dist/ghostty-web.js',
  'node_modules/ghostty-web/dist/ghostty-web.umd.cjs'
]

for (const file of files) {
  let source = readFileSync(file, 'utf8')
  if (source.includes('/* den: scrollbar gutter */')) continue

  if (file.endsWith('.js')) {
    source = source.replace(
      /const g = A \* this\.metrics\.width, E = B \* this\.metrics\.height;\n    this\.canvas\.style\.width = `\$\{g\}px`, this\.canvas\.style\.height = `\$\{E\}px`, this\.canvas\.width = g \* this\.devicePixelRatio,/,
      'const g = A * this.metrics.width, E = B * this.metrics.height, C = g + 12; /* den: scrollbar gutter */\n    this.canvas.style.width = `${C}px`, this.canvas.style.height = `${E}px`, this.canvas.width = C * this.devicePixelRatio,'
    ).replace(
      'this.canvas.width !== D.cols * this.metrics.width * this.devicePixelRatio ||',
      'this.canvas.width !== (D.cols * this.metrics.width + 12) * this.devicePixelRatio ||'
    ).replace(
      'this.theme = { ...f, ...B.theme }, this.devicePixelRatio',
      'this.theme = { ...f, ...B.theme }, this.defaultBackground = this.theme.background, this.devicePixelRatio'
    ).replace(
      'let i = A.bg_r, w = A.bg_g, s = A.bg_b;',
      'let i = A.bg_r, w = A.bg_g, s = A.bg_b; const d = this.defaultBackground.slice(1); if (i === Number.parseInt(d.slice(0, 2), 16) && w === Number.parseInt(d.slice(2, 4), 16) && s === Number.parseInt(d.slice(4, 6), 16)) return; /* den: dynamic default background cells */'
    ).replace(
      'this.wasmTerm.write(A), this.processTerminalResponses(),',
      'typeof A === \"string\" && this.applyDynamicColors(A), this.wasmTerm.write(A), this.processTerminalResponses(),'
    ).replace(
      'checkForTitleChange(A) {',
      'applyDynamicColors(A) { const data = (this.dynamicColorBuffer || \"\") + A; const re = /\\x1b\\]11;([^\\x07\\x1b]*?)(?:\\x07|\\x1b\\\\)/g; let m; while ((m = re.exec(data)) !== null) { if (m[1] !== \"?\" && m[1]) this.renderer.setTheme({ ...this.options.theme, background: m[1] }); } if (/\\x1b\\]111(?:\\x07|\\x1b\\\\)/.test(data)) this.renderer.setTheme(this.options.theme); const start = data.lastIndexOf(\"\\x1b]\"); const tail = start >= 0 ? data.slice(start) : \"\"; this.dynamicColorBuffer = tail && !/(?:\\x07|\\x1b\\\\)/.test(tail) ? tail.slice(-256) : \"\"; } /* den: OSC dynamic colors */\n  checkForTitleChange(A) {'
    )
  } else {
    source = source.replace(
      'const g=A*this.metrics.width,E=B*this.metrics.height;this.canvas.style.width=`${g}px`,this.canvas.style.height=`${E}px`,this.canvas.width=g*this.devicePixelRatio,',
      'const g=A*this.metrics.width,E=B*this.metrics.height,C=g+12;/* den: scrollbar gutter */this.canvas.style.width=`${C}px`,this.canvas.style.height=`${E}px`,this.canvas.width=C*this.devicePixelRatio,'
    ).replace(
      'this.canvas.width!==D.cols*this.metrics.width*this.devicePixelRatio||',
      'this.canvas.width!==(D.cols*this.metrics.width+12)*this.devicePixelRatio||'
    ).replace(
      'this.theme={...j,...B.theme},this.devicePixelRatio',
      'this.theme={...j,...B.theme},this.defaultBackground=this.theme.background,this.devicePixelRatio'
    ).replace(
      'let i=A.bg_r,w=A.bg_g,s=A.bg_b;',
      'let i=A.bg_r,w=A.bg_g,s=A.bg_b;const t=this.defaultBackground.slice(1);if(i===Number.parseInt(t.slice(0,2),16)&&w===Number.parseInt(t.slice(2,4),16)&&s===Number.parseInt(t.slice(4,6),16))return;/* den: dynamic default background cells */'
    ).replace(
      'this.wasmTerm.write(A),this.processTerminalResponses(),',
      'typeof A===\"string\"&&this.applyDynamicColors(A),this.wasmTerm.write(A),this.processTerminalResponses(),'
    ).replace(
      'checkForTitleChange(A){',
      'applyDynamicColors(A){const B=(this.dynamicColorBuffer||\"\")+A,g=/\\x1b\\]11;([^\\x07\\x1b]*?)(?:\\x07|\\x1b\\\\)/g;let E;for(;(E=g.exec(B))!==null;)E[1]!==\"?\"&&E[1]&&this.renderer.setTheme({...this.options.theme,background:E[1]});/\\x1b\\]111(?:\\x07|\\x1b\\\\)/.test(B)&&this.renderer.setTheme(this.options.theme);const C=B.lastIndexOf(\"\\x1b]\"),I=C>=0?B.slice(C):\"\";this.dynamicColorBuffer=I&&!/(?:\\x07|\\x1b\\\\)/.test(I)?I.slice(-256):\"\"}/* den: OSC dynamic colors */checkForTitleChange(A){'
    )
  }

  if (!source.includes('/* den: scrollbar gutter */') || !source.includes('/* den: OSC dynamic colors */') || !source.includes('/* den: dynamic default background cells */')) {
    throw new Error(`ghostty-web layout changed; could not apply renderer fixes in ${file}`)
  }
  writeFileSync(file, source)
}
