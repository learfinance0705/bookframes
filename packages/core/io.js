import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const MANIFEST_FILE = "bookframes.json";

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function resolveManifestPath(inputPath) {
  if (!inputPath) return path.resolve(MANIFEST_FILE);
  const resolved = path.resolve(inputPath);
  if (resolved.endsWith(".json")) return resolved;
  return path.join(resolved, MANIFEST_FILE);
}

export function projectDirFromManifest(manifestPath) {
  return path.dirname(path.resolve(manifestPath));
}
