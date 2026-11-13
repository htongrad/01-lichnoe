import {mkdir, readFile, writeFile} from 'node:fs/promises';
const html = await readFile('index.html', 'utf8');
const worker = await readFile('worker/index.js', 'utf8');
await mkdir('dist/server', {recursive:true});
await writeFile('dist/server/index.js', worker.replace('"__PANEL_HTML__"', () => JSON.stringify(html)));
