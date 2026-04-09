import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Atomically write a JSON file by writing to a sibling `.tmp` file first and
 * then renaming it into place. Parent directories are created as needed.
 */
export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp`;
  const json = JSON.stringify(data);

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmpPath, json, 'utf8');
  await fs.rename(tmpPath, filePath);
}
