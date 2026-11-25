import { cp, mkdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(projectRoot, "node_modules", "@vladmandic", "face-api", "model");
const destination = path.join(projectRoot, "public", "models");

try {
  await access(source, constants.R_OK);
} catch {
  console.error("Could not find the face-api model directory. Run npm install first.");
  process.exit(1);
}

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true, force: true });
console.log("Face-api model files copied to public/models.");
