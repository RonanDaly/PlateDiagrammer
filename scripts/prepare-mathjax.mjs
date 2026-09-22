import { cp, mkdir, mkdtemp, rename, rm, access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export async function prepareMathJax() {
  const vendor = fileURLToPath(new URL('../public/vendor/', import.meta.url));
  await mkdir(vendor, { recursive: true });
  for (const [source, name] of [
    ['mathjax', 'mathjax'],
    ['@mathjax/mathjax-newcm-font', 'mathjax-newcm-font'],
  ]) {
    const sourceDir = new URL(`../node_modules/${source}/`, import.meta.url);
    const { version } = JSON.parse(await readFile(new URL('package.json', sourceDir), 'utf8'));
    const destination = join(vendor, `${name}-${version}`);
    try { await access(destination); continue; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const staging = await mkdtemp(join(vendor, '.prepare-'));
    try {
      await cp(sourceDir, staging, { recursive: true });
      try { await rename(staging, destination); }
      catch (error) {
        // Another renderer may have finished preparing the same version first.
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      }
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await prepareMathJax();
