#!/usr/bin/env node
/**
 * URBAN BREAKTHROUGH: RED VS BLUE — Standalone Offline HTML5 Bundler
 * Concatenates src/ui/styles.css and all 18 JS modules in exact load order,
 * validates zero external network URLs, zero emojis, zero ES module syntax, and clean JS syntax via vm.Script.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = __dirname;

const CSS_FILE = 'src/ui/styles.css';
const JS_FILES = [
  'src/engine/math.js',
  'src/engine/textures.js',
  'src/engine/meshgen.js',
  'src/engine/renderer.js',
  'src/world/physics.js',
  'src/world/destruction.js',
  'src/world/map.js',
  'src/audio/sound.js',
  'src/weapons/catalog.js',
  'src/weapons/viewmodel.js',
  'src/weapons/ballistics.js',
  'src/vehicles/armor.js',
  'src/vehicles/unmanned.js',
  'src/ai/character.js',
  'src/ai/tactics.js',
  'src/ai/gamemode.js',
  'src/ui/hud.js',
  'src/main.js',
];

const OUT_FILE = path.join(ROOT, 'index.html');

function fail(msg) {
  console.error(`\n[BUILD FAILED] ${msg}\n`);
  process.exit(1);
}

function getLineCol(text, index) {
  let line = 1;
  let lastNl = -1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lastNl = i;
    }
  }
  return { line, col: index - lastNl };
}

function checkForbiddenPatterns(relPath, content) {
  const errors = [];

  // 1. Check external URLs and resource tags
  const urlPatterns = [
    { name: 'HTTP/HTTPS URL', re: /https?:\/\//gi },
    { name: 'External <script src>', re: /<script\b[^>]*\bsrc\s*=/gi },
    { name: 'External <link href>', re: /<link\b[^>]*\bhref\s*=/gi },
    { name: 'CSS @import url', re: /@import\s+url\s*\(/gi },
    { name: 'Protocol-relative URL', re: /['"`]\/\/[a-z0-9.-]+\.[a-z]{2,}/gi },
  ];

  for (const { name, re } of urlPatterns) {
    let m;
    while ((m = re.exec(content)) !== null) {
      const { line, col } = getLineCol(content, m.index);
      const snippet = content.slice(Math.max(0, m.index - 20), Math.min(content.length, m.index + 50)).replace(/\n/g, ' ');
      errors.push(`${relPath}:${line}:${col} — Forbidden ${name}: "${snippet.trim()}"`);
    }
  }

  // 2. Check emoji codepoints (Extended_Pictographic and Variation Selector-16)
  const emojiRe = /[\p{Extended_Pictographic}\uFE0F]/gu;
  let em;
  while ((em = emojiRe.exec(content)) !== null) {
    const ch = em[0];
    const cp = ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
    const { line, col } = getLineCol(content, em.index);
    const snippet = content.slice(Math.max(0, em.index - 15), Math.min(content.length, em.index + 15)).replace(/\n/g, ' ');
    errors.push(`${relPath}:${line}:${col} — Forbidden emoji/pictograph U+${cp} near "${snippet.trim()}"`);
  }

  // 3. Check raw </script> closing tag inside JS or CSS that would terminate inline script/style blocks
  if (relPath.endsWith('.js')) {
    const closeScriptRe = /<\/script>/gi;
    let cs;
    while ((cs = closeScriptRe.exec(content)) !== null) {
      const { line, col } = getLineCol(content, cs.index);
      errors.push(`${relPath}:${line}:${col} — Literal </script> inside JS breaks HTML inline script; escape as <\\/script>`);
    }
    // Check accidental ES module import/export at line start
    const esmRe = /^[ \t]*(?:import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]|export\s+(?:default\s+|const\s+|let\s+|var\s+|function\s+|class\s+|\{))/gm;
    let esm;
    while ((esm = esmRe.exec(content)) !== null) {
      const { line, col } = getLineCol(content, esm.index);
      errors.push(`${relPath}:${line}:${col} — ES module import/export syntax is forbidden (use IIFE attaching to window.DF)`);
    }
  } else if (relPath.endsWith('.css')) {
    const closeStyleRe = /<\/style>/gi;
    let cst;
    while ((cst = closeStyleRe.exec(content)) !== null) {
      const { line, col } = getLineCol(content, cst.index);
      errors.push(`${relPath}:${line}:${col} — Literal </style> inside CSS breaks HTML inline style`);
    }
  }

  return errors;
}

function build() {
  const startTime = Date.now();
  const requiredFiles = [CSS_FILE, ...JS_FILES];
  const missing = requiredFiles.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
  if (missing.length > 0) {
    fail(`Missing ${missing.length} required source file(s):\n  - ${missing.join('\n  - ')}`);
  }

  const allErrors = [];
  const cssContent = fs.readFileSync(path.join(ROOT, CSS_FILE), 'utf8');
  allErrors.push(...checkForbiddenPatterns(CSS_FILE, cssContent));

  const jsSegments = [];
  const moduleStats = [];
  let runningLine = 1;
  const lineMap = []; // { startLine, endLine, file }

  for (const relPath of JS_FILES) {
    const absPath = path.join(ROOT, relPath);
    const code = fs.readFileSync(absPath, 'utf8');
    allErrors.push(...checkForbiddenPatterns(relPath, code));

    // Per-module syntax validation via vm.Script
    try {
      new vm.Script(code, { filename: relPath });
    } catch (err) {
      const stackLine = (err.stack || '').split('\n').slice(0, 4).join('\n');
      allErrors.push(`Syntax error in ${relPath}: ${err.message}\n${stackLine}`);
    }

    const header = `/* ==================== ${relPath} ==================== */\n`;
    const body = `${code.trimEnd()}\n;\n`;
    const segment = header + body;
    const segLines = segment.split('\n').length - 1;
    lineMap.push({ startLine: runningLine, endLine: runningLine + segLines - 1, file: relPath });
    runningLine += segLines;

    jsSegments.push(segment);
    moduleStats.push({ file: relPath, bytes: Buffer.byteLength(code, 'utf8') });
  }

  if (allErrors.length > 0) {
    fail(`Validation errors detected (${allErrors.length}):\n  * ${allErrors.join('\n  * ')}`);
  }

  const concatenatedJs = jsSegments.join('\n');

  // Full concatenated bundle syntax validation via vm.Script
  try {
    new vm.Script(concatenatedJs, { filename: 'donbas-frontline.bundle.js' });
  } catch (err) {
    let moduleHint = '';
    const lineMatch = (err.stack || '').match(/donbas-frontline\.bundle\.js:(\d+)/);
    if (lineMatch) {
      const bundleLine = parseInt(lineMatch[1], 10);
      const entry = lineMap.find((m) => bundleLine >= m.startLine && bundleLine <= m.endLine);
      if (entry) {
        moduleHint = ` (approx ${entry.file}:${bundleLine - entry.startLine})`;
      }
    }
    fail(`Concatenated bundle syntax error${moduleHint}: ${err.message}\n${err.stack}`);
  }

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>URBAN BREAKTHROUGH // 城市突破：红蓝对抗</title>
<style>
${cssContent}
</style>
</head>
<body>
<div id="game-root">
  <canvas id="gl-canvas"></canvas>
  <div id="ui-layer"></div>
</div>
<script>
'use strict';
window.DF = window.DF || {};
${concatenatedJs}
</script>
</body>
</html>
`;

  // Final pass hygiene check on emitted HTML
  const htmlErrors = checkForbiddenPatterns('index.html', html);
  if (htmlErrors.length > 0) {
    fail(`Final HTML audit failed (${htmlErrors.length}):\n  * ${htmlErrors.join('\n  * ')}`);
  }

  fs.writeFileSync(OUT_FILE, html, 'utf8');
  const totalBytes = Buffer.byteLength(html, 'utf8');
  const cssBytes = Buffer.byteLength(cssContent, 'utf8');
  const jsBytes = Buffer.byteLength(concatenatedJs, 'utf8');
  const elapsed = Date.now() - startTime;

  console.log('=== URBAN BREAKTHROUGH (RED VS BLUE) BUILD SUCCEEDED ===');
  console.log(`Output: ${OUT_FILE}`);
  console.log(`Total size: ${(totalBytes / 1024).toFixed(1)} KB (CSS: ${(cssBytes / 1024).toFixed(1)} KB, JS: ${(jsBytes / 1024).toFixed(1)} KB)`);
  console.log(`Modules (${JS_FILES.length}):`);
  for (const s of moduleStats) {
    console.log(`  - ${s.file.padEnd(28)} ${(s.bytes / 1024).toFixed(1).padStart(6)} KB`);
  }
  console.log(`Checks: ZERO external URLs | ZERO emojis | vm.Script syntax OK | ${elapsed} ms`);
}

build();
