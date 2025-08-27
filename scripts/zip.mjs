import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, 'build.zip');

if (!fs.existsSync(DIST)) {
  console.error('dist/ not found. Run `npm run build` first.');
  process.exit(1);
}

if (fs.existsSync(OUT)) fs.rmSync(OUT);
execSync(`cd dist && zip -r ../build.zip .`, { stdio: 'inherit' });
console.log(`[zip] created build.zip`);
