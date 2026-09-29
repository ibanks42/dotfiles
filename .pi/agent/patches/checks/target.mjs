import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

const here = fileURLToPath(new URL('.', import.meta.url));
const npmRoot = resolve(here, '../../npm');
export const fixtures = join(here, 'fixtures');
export function target(packageName) {
 const root = process.env.PI_PATCH_PACKAGE_ROOT || join(npmRoot, 'node_modules', packageName);
 if (!existsSync(join(root, 'package.json'))) throw new Error(`Missing target package: ${root}`);
 return resolve(root);
}
export function dependency(packageRoot, specifier) {
 const requireFromTarget = createRequire(join(packageRoot, 'package.json'));
 try { return requireFromTarget.resolve(specifier); }
 catch {
  const fromNpm = createRequire(join(npmRoot, 'package.json'));
  return fromNpm.resolve(specifier);
 }
}
export async function bridgeLoader(packageRoot) {
 const { createJiti } = await import(pathToFileURL(dependency(packageRoot, 'jiti')).href);
 return createJiti(join(packageRoot, 'src', 'index.ts'));
}
export const sourcePath = (root, name) => join(root, 'src', name);
