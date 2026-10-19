import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("manifest is GitHub/npm-installable and keeps host packages as peers", () => {
  assert.equal(manifest.name, "pi-resources");
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  assert.equal(manifest.type, "module");
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.deepEqual(manifest.pi.extensions, ["./src/index.ts"]);
  assert.equal(manifest.publishConfig.access, "public");
  assert.match(manifest.repository.url, /github\.com\/sgrimee\/pi-resources\.git$/);
  for (const host of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
    assert.equal(manifest.peerDependencies[host], "*");
    assert.equal(manifest.dependencies?.[host], undefined);
  }
});

test("loading the package directory discovers exactly the declared entry point", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "pi-resources-package-"));
  try {
    const loaded = await discoverAndLoadExtensions([root], sandbox, sandbox);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    assert.equal(loaded.extensions[0].path, path.join(root, "src/index.ts"));
    assert.ok(loaded.extensions[0].commands.has("resources"));
    assert.equal(loaded.extensions[0].shortcuts.size, 0);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("npm tarball includes runnable source and public docs, never local config or tests", () => {
  // Avoid recursive prepack -> tests -> prepack while exercising npm's real file selection.
  const output = execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", npm_config_color: "false" },
  });
  const [pack] = JSON.parse(output);
  assert.equal(pack.name, manifest.name);
  assert.equal(pack.version, manifest.version);
  assert.deepEqual(pack.files.map((file) => file.path).sort(), [
    "CHANGELOG.md", "LICENSE", "README.md", "package.json", "src/browser.ts", "src/index.ts",
  ]);
  assert.deepEqual(pack.bundled, []);
});
