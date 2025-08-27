import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '..', 'src');
const MOD_DIR = path.join(SRC_DIR, 'modules');
const OUT_DIR = path.join(SRC_DIR, '_generated');
const OUT_FILE = path.join(OUT_DIR, 'registry.ts');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const files = fs.readdirSync(MOD_DIR).filter(f => f.endsWith('.ts'));

const imports = [];
const modules = [];
for (const f of files) {
  const name = path.basename(f, '.ts');
  const varName = name.replace(/[^a-zA-Z0-9_$]/g, '_');
  imports.push(`import * as ${varName} from "../modules/${name}.js";`);
  modules.push(varName);
}

const cssFiles = fs.readdirSync(MOD_DIR).filter(f => f.endsWith('.css'));

const content = `// AUTO-GENERATED. DO NOT EDIT.
${imports.join('\n')}

export const registry = [${modules.join(', ')}];

export const cssFiles = ${JSON.stringify(cssFiles, null, 2)};
`;

fs.writeFileSync(OUT_FILE, content, 'utf8');
console.log(`[gen-registry] Found ${modules.length} modules, ${cssFiles.length} css`);
