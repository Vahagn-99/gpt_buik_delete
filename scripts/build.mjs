import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import esbuild from 'esbuild';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const s = path.join(src, entry);
    const d = path.join(dest, entry);
    const stat = fs.statSync(s);
    if (stat.isDirectory()) copyRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

function concatCss() {
  const regFile = path.join(SRC, '_generated', 'registry.ts');
  const gen = fs.readFileSync(regFile, 'utf8');
  const m = gen.match(/export const cssFiles = ([\s\S]*?);/);
  const moduleCssList = m ? JSON.parse(m[1]) : [];
  const chunks = [];
  const baseCss = path.join(SRC, 'styles', 'main.css');
  if (fs.existsSync(baseCss)) chunks.push(fs.readFileSync(baseCss, 'utf8'));
  for (const rel of moduleCssList) {
    const p = path.join(SRC, 'modules', rel);
    if (fs.existsSync(p)) chunks.push(fs.readFileSync(p, 'utf8'));
  }
  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(path.join(DIST, 'content.css'), chunks.join('\n\n'), 'utf8');
}

(async () => {
  execSync('node scripts/gen-registry.mjs', { stdio: 'inherit' });

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(SRC, 'content', 'main.ts')],
    bundle: true,
    minify: true,
    target: ['chrome120'],
    format: 'iife',
    outfile: path.join(DIST, 'content.js'),
    sourcemap: false,
    logLevel: 'info'
  });

  concatCss();

  fs.copyFileSync(path.join(ROOT, 'manifest.json'), path.join(DIST, 'manifest.json'));
  copyRecursive(path.join(ROOT, 'icons'), path.join(DIST, 'icons'));

  console.log('[build] done.');
})();
