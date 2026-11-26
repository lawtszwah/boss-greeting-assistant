// 打包到 dist/：内容脚本和弹窗为 IIFE（内容脚本不支持 ES 模块），后台为 ES 模块。
// 开发者模式下加载 dist/ 目录即可。
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const outdir = new URL('../dist/', import.meta.url).pathname;
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const common = { bundle: true, target: 'chrome120', legalComments: 'inline', logLevel: 'info' };
await build({ ...common, entryPoints: ['src/content/main.js'], outfile: `${outdir}content.js`, format: 'iife' });
await build({ ...common, entryPoints: ['src/background/service-worker.js'], outfile: `${outdir}background.js`, format: 'esm' });
await build({ ...common, entryPoints: ['src/popup/main.js'], outfile: `${outdir}popup.js`, format: 'iife' });
await cp('manifest.json', `${outdir}manifest.json`);
await cp('src/popup/popup.html', `${outdir}popup.html`);
await cp('src/popup/popup.css', `${outdir}popup.css`);

if (process.argv.includes('--preview')) {
  await build({ ...common, entryPoints: ['scripts/popup-preview.js'], outfile: `${outdir}preview.js`, format: 'esm' });
  const { readFile, writeFile } = await import('node:fs/promises');
  const html = await readFile('src/popup/popup.html', 'utf8');
  await writeFile(`${outdir}preview.html`, html.replace('<script src="popup.js"></script>', '<script type="module" src="preview.js"></script>'));
}
