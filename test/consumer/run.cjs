const { execFileSync } = require("node:child_process");
const { readFileSync, readdirSync, mkdirSync, rmSync } = require("node:fs");
const path = require("node:path");

const fixtureDirectory = __dirname;
const packageDirectory = path.resolve(fixtureDirectory, "../..");
const artifactsDirectory = path.join(fixtureDirectory, ".artifacts");
const zodVersion = process.env.ZOD_VERSION || "4.3.6";
const awsSdkVersion = process.env.AWS_SDK_VERSION || "3.1037.0";

function run(command, args, cwd = fixtureDirectory) {
  execFileSync(command, args, {
    cwd,
    shell: process.platform === "win32" && !path.isAbsolute(command),
    stdio: "inherit"
  });
}

function assertNoBufferTypes(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      assertNoBufferTypes(entryPath);
    } else if (entry.name.endsWith(".d.ts") && /\bBuffer\b/.test(readFileSync(entryPath, "utf8"))) {
      throw new Error(`Published declaration contains a Node Buffer type: ${entryPath}`);
    }
  }
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
  path.join(artifactsDirectory, tarball),
  `zod@${zodVersion}`,
  `@aws-sdk/client-dynamodb@${awsSdkVersion}`
]);
run("npx", ["tsc", "--project", "tsconfig.json"]);
run("npx", ["webpack", "--config", "webpack.config.cjs"]);
run(process.execPath, ["require.cjs"]);
run(process.execPath, ["import.mjs"]);
assertNoBufferTypes(path.join(fixtureDirectory, "node_modules", "@fluentful", "orm", "dist"));

async function verifyBrowser() {
  run("npx", ["playwright", "install", ...(process.env.CI ? ["--with-deps"] : []), "chromium"]);
  const { createServer } = require("node:http");
  const { chromium } = require("playwright");
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = pathname === "/browser.html" ? path.join(fixtureDirectory, "browser.html")
      : pathname === "/dist/consumer.js" ? path.join(fixtureDirectory, "dist", "consumer.js") : null;
    if (!file) { response.writeHead(404).end(); return; }
    response.setHeader("Content-Type", pathname.endsWith(".js") ? "text/javascript" : "text/html");
    response.end(readFileSync(file));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let browser;
  try {
    browser = await chromium.launch();
    for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", error => errors.push({name: error.name, message: error.message, stack: error.stack}));
        await page.goto(`http://127.0.0.1:${server.address().port}/browser.html`);
        await page.waitForFunction(() => ["passed", "failed"].includes(document.body.dataset.browserTest));
        const result = await page.locator("body").getAttribute("data-browser-test");
        if (result !== "passed" || errors.length) throw new Error(JSON.stringify({result, text: await page.locator("body").innerText(), errors}, null, 2));
        console.log(`Chromium IndexedDB smoke passed (${viewport.width}x${viewport.height})`);
      } finally { await context.close(); }
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

if (process.argv.includes("--browser")) {
  verifyBrowser().catch(error => { console.error(error); process.exitCode = 1; });
}
