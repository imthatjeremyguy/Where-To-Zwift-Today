// Runs every browser test suite against a local copy of the site.
//
//   node tests/run.js            run all suites
//   node tests/run.js spinner    run suites whose file name contains "spinner"
//
// The server serves the site from the repo root, except data/*.json, which
// comes from tests/fixtures/data: a frozen snapshot, so results don't change
// as the daily Action updates the real data. Refresh the snapshot with
// `cp data/*.json tests/fixtures/data/` when the tests need newer data.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.join(__dirname, "fixtures", "data");
const PORT = Number(process.env.PORT || 8765);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
};

function serve(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const base = relative.startsWith("data/") ? FIXTURES : ROOT;
  const file = path.join(base, relative.startsWith("data/") ? relative.slice(5) : relative);
  if (!file.startsWith(base)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (error, body) => {
    if (error) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  });
}

function runSuite(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      env: { ...process.env, BASE_URL: `http://localhost:${PORT}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => { output += d; });
    child.stderr.on("data", (d) => { output += d; });
    child.on("close", (code) => resolve({ code, output }));
  });
}

async function main() {
  const filter = process.argv[2] || "";
  const suites = fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.js") && f.includes(filter)).sort();
  const server = http.createServer(serve);
  await new Promise((resolve) => server.listen(PORT, resolve));

  let failed = 0;
  for (const suite of suites) {
    const { code, output } = await runSuite(path.join(__dirname, suite));
    const checks = (output.match(/^PASS /gm) || []).length;
    if (code === 0) {
      console.log(`ok    ${suite} (${checks} checks)`);
    } else {
      failed++;
      console.log(`FAIL  ${suite}`);
      // Show the failing checks and any error, not the whole log.
      console.log(output.split("\n").filter((l) => !l.startsWith("PASS ")).join("\n").trim().replace(/^/gm, "      "));
    }
  }
  server.close();
  console.log(failed ? `\n${failed} of ${suites.length} suites failed` : `\nall ${suites.length} suites passed`);
  process.exitCode = failed ? 1 : 0;
}

main();
