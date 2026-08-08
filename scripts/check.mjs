import { readFile } from 'node:fs/promises';
const files = ['index.html','styles.css','app.js','fft-worker.js','server.mjs'];
for (const file of files) {
  const source = await readFile(file, 'utf8');
  if (!source.trim()) throw new Error(`${file} is empty`);
  if (file.endsWith('.js') || file.endsWith('.mjs')) new Function(file === 'server.mjs' ? source.replace(/^import .*;$/gm, '') : source);
}
console.log(`Validated ${files.length} source files.`);
