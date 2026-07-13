import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const assets = [
  ['src/secrets/sv-secrets.mjs', 'dist/src/secrets/sv-secrets.mjs'],
  ['v04_config.json', 'dist/v04_config.json'],
];

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

for (const [source, destination] of assets) {
  const destinationPath = resolve(repositoryRoot, destination);
  await mkdir(dirname(destinationPath), { recursive: true });
  await copyFile(resolve(repositoryRoot, source), destinationPath);
}
