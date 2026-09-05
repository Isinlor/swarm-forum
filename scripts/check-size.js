#!/usr/bin/env node
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const files = execFileSync('git', ['ls-files', '-z']).toString().split('\0').filter(Boolean);
const decoder = new TextDecoder('utf-8', { fatal: true });
let lines = 0; let characters = 0;
for (const file of files) {
  let text;
  try { text = decoder.decode(fs.readFileSync(file)); }
  catch { console.error(`invalid UTF-8: ${file}`); process.exitCode = 1; continue; }
  if (text.length) lines += (text.match(/\n/g) || []).length + (text.endsWith('\n') ? 0 : 1);
  characters += [...text].length;
}
console.log(`${files.length} tracked files: ${lines} lines, ${characters} characters`);
if (lines > 5000 || characters > 200000) {
  console.error('project exceeds the limit of 5,000 lines or 200,000 characters');
  process.exitCode = 1;
}
