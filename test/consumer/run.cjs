const { execFileSync } = require("node:child_process");
const { readdirSync, mkdirSync, rmSync } = require("node:fs");
const path = require("node:path");

const fixtureDirectory = __dirname;
const packageDirectory = path.resolve(fixtureDirectory, "../..");
const artifactsDirectory = path.join(fixtureDirectory, ".artifacts");

function run(command, args, cwd = fixtureDirectory) {
  execFileSync(command, args, {
    cwd,
    shell: process.platform === "win32" && !path.isAbsolute(command),
    stdio: "inherit"
  });
}

rmSync(path.join(fixtureDirectory, "node_modules"), { recursive: true, force: true });
rmSync(path.join(fixtureDirectory, "dist"), { recursive: true, force: true });
rmSync(artifactsDirectory, { recursive: true, force: true });
mkdirSync(artifactsDirectory, { recursive: true });

run("npm", ["pack", "--pack-destination", artifactsDirectory], packageDirectory);

const tarball = readdirSync(artifactsDirectory).find((file) => file.endsWith(".tgz"));
if (!tarball) {
  throw new Error("npm pack did not produce a tarball.");
}

run("npm", ["install", "--include=dev", "--package-lock=false", "--ignore-scripts"]);
run("npm", [
  "install",
  "--package-lock=false",
  "--ignore-scripts",
  "--no-save",
  path.join(artifactsDirectory, tarball)
]);
run("npx", ["tsc", "--project", "tsconfig.json"]);
run("npx", ["webpack", "--config", "webpack.config.cjs"]);
run(process.execPath, ["require.cjs"]);
run(process.execPath, ["import.mjs"]);
