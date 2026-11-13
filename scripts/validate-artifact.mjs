import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workerPath = resolve(projectRoot, "dist/server/index.js");
const manifestPath = resolve(projectRoot, "dist/.openai/hosting.json");

const [source, manifest] = await Promise.all([
  readFile(workerPath, "utf8"),
  readFile(manifestPath, "utf8"),
]);
JSON.parse(manifest);

// A data URL forces ESM parsing even though the generated output has no package.json.
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const workerModule = await import(moduleUrl);
assert.equal(
  typeof workerModule.default?.fetch,
  "function",
  `${pathToFileURL(workerPath)} must export default.fetch`,
);

const expectedHTML = await readFile(resolve(projectRoot, "worker/app.html"), "utf8");
const response = await workerModule.default.fetch(new Request("https://artifact.test/"), {});
assert.equal(await response.text(), expectedHTML.replace('__GOOGLE_CLIENT_ID__',process.env.GOOGLE_CLIENT_ID||''), "Built Worker must serve the current UI source exactly");
console.log("Artifact is valid ESM and serves the current HTML source exactly");
