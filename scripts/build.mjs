import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
await rm('dist', { recursive:true, force:true }); await mkdir('dist');
for (const file of ['index.html','styles.css','app.js','fft-worker.js','vercel.json']) await cp(file, `dist/${file}`);
await writeFile('dist/.build', new Date().toISOString());
console.log('Production files written to dist/.');
