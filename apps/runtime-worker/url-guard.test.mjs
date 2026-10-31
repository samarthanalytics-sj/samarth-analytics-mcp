// Runtime worker tests. Run with: node --test url-guard.test.mjs
// SSRF guard unit tests first, then the admission rules around it (server
// startup auth, the concurrency cap, queue-mode URL checks) and the Docker
// image contents. Node built-ins only: CI installs nothing for this worker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect as netConnect, createServer as createNetServer } from "node:net";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { urlAllowed, createRequestGuard, watchLanding } from "./url-guard.mjs";

test("allows ordinary public http(s) URLs", () => {
  assert.equal(urlAllowed("https://example.com/").ok, true);
  assert.equal(urlAllowed("http://shop.example.com/checkout").ok, true);
  assert.equal(urlAllowed("https://www.google-analytics.com/g/collect").ok, true);
});

test("rejects non-http(s) schemes", () => {
  for (const u of [
    "file:///etc/passwd",
    "ftp://example.com/",
    "gopher://example.com/",
    "data:text/html,<script>",
  ]) {
    assert.equal(urlAllowed(u).ok, false, u);
  }
});

test("blocks loopback by name and IP", () => {
  for (const u of [
    "http://localhost/",
    "http://localhost:8080/admin",
    "http://foo.localhost/",
    "http://127.0.0.1/",
    "http://127.1/", // shorthand → normalized
    "https://0.0.0.0/",
  ]) {
    assert.equal(urlAllowed(u).ok, false, u);
  }
});

test("blocks the trailing-dot (FQDN) spelling of loopback names", () => {
  for (const u of [
    "http://localhost./",
    "http://foo.localhost./",
    "http://ip6-localhost./",
    "http://LOCALHOST../",
  ]) {
    assert.equal(urlAllowed(u).ok, false, u);
  }
});

test("matches the allowlist against the trailing-dot spelling", () => {
  assert.equal(urlAllowed("https://client.com./", ["client.com"]).ok, true);
  assert.equal(urlAllowed("https://evilclient.com./", ["client.com"]).ok, false);
});

test("blocks RFC-1918 and CGNAT ranges", () => {
  for (const u of [
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://100.64.0.1/",
  ]) {
    assert.equal(urlAllowed(u).ok, false, u);
  }
  // 172.32 is public (outside 16-31).
  assert.equal(urlAllowed("http://172.32.0.1/").ok, true);
});

test("blocks the cloud metadata endpoint (169.254.169.254) and link-local", () => {
  assert.equal(urlAllowed("http://169.254.169.254/latest/meta-data/").ok, false);
  assert.equal(urlAllowed("http://169.254.0.1/").ok, false);
});

test("blocks decimal / octal / hex IP encodings of 127.0.0.1", () => {
  for (const u of [
    "http://2130706433/", // decimal
    "http://0x7f000001/", // hex
    "http://0177.0.0.1/", // octal first octet
    "http://0x7f.0.0.1/", // hex first octet
  ]) {
    assert.equal(urlAllowed(u).ok, false, u);
  }
});

test("blocks decimal encoding of the metadata IP", () => {
  // 169.254.169.254 = 2852039166
  assert.equal(urlAllowed("http://2852039166/").ok, false);
});

test("blocks IPv6 loopback and private ranges", () => {
  for (const u of [
    "http://[::1]/",
    "http://[fc00::1]/",
    "http://[fd12:3456::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/", // IPv4-mapped loopback
    "http://[::ffff:169.254.169.254]/", // IPv4-mapped metadata
  ]) {
    assert.equal(urlAllowed(u).ok, false, u);
  }
});

test("enforces the allowlist when provided", () => {
  const allow = ["example.com", "shop.test"];
  assert.equal(urlAllowed("https://example.com/", allow).ok, true);
  assert.equal(urlAllowed("https://a.example.com/", allow).ok, true);
  assert.equal(urlAllowed("https://shop.test/", allow).ok, true);
  assert.equal(urlAllowed("https://evil.com/", allow).ok, false);
  // Suffix confusion: notexample.com must NOT match example.com.
  assert.equal(urlAllowed("https://notexample.com/", allow).ok, false);
});

test("allowlist never overrides the private-IP block", () => {
  // Even if an attacker controls a host in the allowlist that points internal,
  // an explicit internal IP target is still rejected.
  assert.equal(urlAllowed("http://127.0.0.1/", ["127.0.0.1"]).ok, false);
});

// A fake resolver: answers from a table, counts calls, throws for unknown names.
function fakeLookup(table) {
  const calls = [];
  const lookup = async (hostname) => {
    calls.push(hostname);
    const addrs = table[hostname];
    if (!addrs) throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    return addrs;
  };
  return { lookup, calls };
}

test("request guard blocks a public-looking NAME that resolves to a private address", async () => {
  const { lookup } = fakeLookup({
    "metadata.google.internal": [{ address: "169.254.169.254", family: 4 }],
    "127.0.0.1.nip.io": [{ address: "127.0.0.1", family: 4 }],
    "db": [{ address: "172.18.0.3", family: 4 }],
    "v6-loop.example.com": [{ address: "::1", family: 6 }],
    "mixed.example.com": [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.7", family: 4 },
    ],
  });
  const allowed = createRequestGuard(lookup);
  // The string check alone lets every one of these through.
  for (const u of [
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://127.0.0.1.nip.io/",
    "http://db:5432/",
    "http://v6-loop.example.com/",
    "http://mixed.example.com/",
  ]) {
    assert.equal(urlAllowed(u).ok, true, `string check passes ${u}`);
    assert.equal(await allowed(u), false, u);
  }
});

test("request guard admits public names and IP literals, and fails closed on lookup errors", async () => {
  const { lookup, calls } = fakeLookup({
    "example.com": [{ address: "93.184.216.34", family: 4 }],
  });
  const allowed = createRequestGuard(lookup);
  assert.equal(await allowed("https://example.com/"), true);
  assert.equal(await allowed("http://93.184.216.34/"), true);
  assert.equal(await allowed("https://does-not-resolve.example/"), false);
  // String-check failures never reach DNS, and neither does an IP literal.
  assert.equal(await allowed("http://169.254.169.254/"), false);
  assert.equal(await allowed("file:///etc/passwd"), false);
  assert.deepEqual(calls, ["example.com", "does-not-resolve.example"]);
});

test("request guard resolves each host once per guard", async () => {
  const { lookup, calls } = fakeLookup({
    "cdn.example.com": [{ address: "93.184.216.34", family: 4 }],
  });
  const allowed = createRequestGuard(lookup);
  const verdicts = await Promise.all(
    Array.from({ length: 20 }, (_, i) => allowed(`https://cdn.example.com/asset-${i}.js`)),
  );
  assert.ok(verdicts.every(Boolean));
  assert.equal(calls.length, 1);
  // A fresh guard (a new browser context) resolves again.
  await createRequestGuard(lookup)("https://cdn.example.com/x.js");
  assert.equal(calls.length, 2);
});

test("request guard does not remember a failed lookup, so a transient error is retried", async () => {
  // One guard serves every URL of a consent state: a single EAI_AGAIN used to be
  // cached as "blocked" and refuse that host for all the remaining pages.
  let failures = 1;
  const calls = [];
  const lookup = async (hostname) => {
    calls.push(hostname);
    if (failures > 0) {
      failures -= 1;
      throw Object.assign(new Error(`getaddrinfo EAI_AGAIN ${hostname}`), { code: "EAI_AGAIN" });
    }
    return [{ address: "93.184.216.34", family: 4 }];
  };
  const allowed = createRequestGuard(lookup);
  assert.equal(await allowed("https://flaky.example.com/"), false, "fails closed while the lookup fails");
  assert.equal(await allowed("https://flaky.example.com/next"), true, "retried after the error");
  assert.equal(await allowed("https://flaky.example.com/again"), true, "and the real answer is then remembered");
  assert.deepEqual(calls, ["flaky.example.com", "flaky.example.com"]);
});

test("request guard still remembers a private answer (the retry is for errors only)", async () => {
  const { lookup, calls } = fakeLookup({ "inside.example.com": [{ address: "10.0.0.7", family: 4 }] });
  const allowed = createRequestGuard(lookup);
  assert.equal(await allowed("http://inside.example.com/a"), false);
  assert.equal(await allowed("http://inside.example.com/b"), false);
  assert.equal(calls.length, 1);
});

// Redirect hops. Playwright routes only the FIRST URL of a redirect chain, so the
// capture.mjs route guard never saw a public URL 302ing to an internal address:
// the page loaded and its final URL, status, dataLayer and cookies were recorded.
// watchLanding re-checks every hop; these drive it with a fake Playwright page.
function fakeReq(url, from = null) {
  return { url: () => url, redirectedFrom: () => from };
}
function fakePage(frames = []) {
  const listeners = [];
  const page = {
    current: "about:blank",
    gotos: [],
    on: (event, cb) => {
      if (event === "request") listeners.push(cb);
    },
    url: () => page.current,
    frames: () => frames.map((u) => ({ url: () => u })),
    goto: async (url) => {
      page.gotos.push(url);
      page.current = url;
    },
    emit: (req) => listeners.forEach((cb) => cb(req)),
  };
  return page;
}
const publicGuard = () =>
  createRequestGuard(
    fakeLookup({
      "shop.example.com": [{ address: "93.184.216.34", family: 4 }],
      "cdn.example.com": [{ address: "93.184.216.34", family: 4 }],
      "metadata.google.internal": [{ address: "169.254.169.254", family: 4 }],
    }).lookup,
  );

test("watchLanding refuses a main-frame redirect to a private address and leaves the page", async () => {
  const page = fakePage();
  const landing = watchLanding(page, publicGuard());
  const first = fakeReq("https://shop.example.com/");
  const last = fakeReq("http://10.0.0.5:8080/admin", first);
  page.emit(first);
  page.emit(last);
  page.current = "http://10.0.0.5:8080/admin";
  const note = await landing.blockedLanding({ request: () => last });
  assert.match(note ?? "", /^Blocked: redirected to 10\.0\.0\.5:8080/);
  assert.deepEqual(page.gotos, ["about:blank"], "moved off the internal page once");
  assert.equal(await landing.blockedLanding(null), note, "the refusal holds");
  assert.deepEqual(page.gotos, ["about:blank"]);
});

test("watchLanding refuses a private hop in the response chain alone", async () => {
  const page = fakePage();
  page.current = "https://shop.example.com/done";
  const landing = watchLanding(page, publicGuard());
  const chain = fakeReq(
    "https://shop.example.com/done",
    fakeReq("http://metadata.google.internal/x", fakeReq("https://shop.example.com/")),
  );
  assert.match((await landing.blockedLanding({ request: () => chain })) ?? "", /metadata\.google\.internal/);
});

test("watchLanding refuses an iframe/subresource redirect seen only as a request event", async () => {
  const page = fakePage(["https://shop.example.com/", "chrome-error://chromewebdata/"]);
  page.current = "https://shop.example.com/";
  const landing = watchLanding(page, publicGuard());
  page.emit(fakeReq("http://169.254.169.254/latest/meta-data/", fakeReq("https://cdn.example.com/frame")));
  assert.match((await landing.blockedLanding(null)) ?? "", /169\.254\.169\.254/);
});

test("watchLanding passes a public redirect and ignores non-http frames", async () => {
  const page = fakePage(["https://shop.example.com/landing", "about:blank", "chrome-error://chromewebdata/"]);
  const landing = watchLanding(page, publicGuard());
  const first = fakeReq("https://shop.example.com/");
  const last = fakeReq("https://shop.example.com/landing", first);
  page.emit(first);
  page.emit(last);
  page.current = "https://shop.example.com/landing";
  assert.equal(await landing.blockedLanding({ request: () => last }), null);
  assert.deepEqual(page.gotos, []);
});

// capturePage needs a browser, so pin its wiring in the source: the watch is
// registered before goto, the landing is checked before the final URL/status are
// recorded, and again after the dataLayer/cookie reads.
test("capture.mjs checks the landing before it records anything from a page", async () => {
  const src = await readFile(new URL("./capture.mjs", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("async function capturePage("));
  const watch = body.indexOf("watchLanding(page");
  const goto = body.indexOf("page.goto(");
  const first = body.indexOf("blockedLanding(");
  const finalUrl = body.indexOf("record.finalUrl = page.url()");
  const reads = body.indexOf("record.dataLayerAfter = await");
  const late = body.lastIndexOf("blockedLanding(", body.indexOf("} catch (e)"));
  assert.ok(watch > 0 && watch < goto, `watch@${watch} goto@${goto}`);
  assert.ok(first > goto && first < finalUrl, `landing@${first} finalUrl@${finalUrl}`);
  assert.ok(late > reads, `late landing@${late} reads@${reads}`);
  assert.match(src, /capturePage\(context, url, \{[^}]*requestAllowed/, "the context's guard is passed in");
});

// ── Docker image contents ───────────────────────────────────────────────────

const dockerfile = readFileSync(new URL("./Dockerfile", import.meta.url), "utf8");
const workerPkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

test("Dockerfile copies every module the image runs, and everything they import", () => {
  const copied = new Set();
  for (const line of dockerfile.split("\n")) {
    const m = /^COPY\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    const parts = m[1].split(/\s+/).filter((p) => !p.startsWith("--"));
    parts.pop(); // destination
    for (const p of parts) copied.add(p.replace(/^\.\//, ""));
  }
  const cmd = /^CMD\s+\[\s*"node",\s*"([^"]+)"/m.exec(dockerfile)?.[1];
  assert.ok(cmd, "Dockerfile has a CMD [\"node\", ...]");
  // The CMD entry, every `node <file>.mjs` npm script, and every copied module.
  const entries = new Set([cmd, ...[...copied].filter((f) => f.endsWith(".mjs"))]);
  for (const script of Object.values(workerPkg.scripts ?? {})) {
    for (const m of script.matchAll(/\bnode\s+([\w.-]+\.mjs)\b/g)) entries.add(m[1]);
  }
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    assert.ok(copied.has(file), `${file} is needed at runtime but the Dockerfile never COPYs it`);
    const src = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    const rel = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']\.\/([^"']+)["']/g;
    for (const m of src.matchAll(rel)) queue.push(m[1]);
  }
  assert.ok(seen.has("url-guard.mjs"), "the import walk reached url-guard.mjs");
});

test("Dockerfile base image ships the browsers for the exact pinned playwright", () => {
  // The image installs from package.json alone (no lockfile reaches the build), and its
  // /ms-playwright only holds browsers for the tag's version, so a range would drift.
  const pinned = workerPkg.optionalDependencies?.playwright ?? workerPkg.dependencies?.playwright;
  assert.match(String(pinned), /^\d+\.\d+\.\d+$/, `playwright must be pinned exactly, got ${pinned}`);
  const tag = /^FROM\s+mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-\S+/m.exec(dockerfile)?.[1];
  assert.equal(tag, pinned, `FROM tag v${tag} must equal package.json playwright ${pinned}`);
});

// ── server.mjs: startup auth, bind address, concurrency cap ─────────────────

const HERE = fileURLToPath(new URL(".", import.meta.url));

async function freePort() {
  const srv = createNetServer();
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

/** Start server.mjs with only `env` set among the worker's variables. Resolves on the
 *  listening banner or on exit, whichever comes first. */
async function startWorker(env) {
  const port = await freePort();
  const childEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) {
    if (k.startsWith("RUNTIME_WORKER_") || k === "PORT" || k === "NODE_TEST_CONTEXT") delete childEnv[k];
  }
  Object.assign(childEnv, { PORT: String(port) }, env);
  const child = spawn(process.execPath, ["server.mjs"], { cwd: HERE, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.on("data", (c) => { stderr += c; });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "timeout" }), 10_000);
    const onData = () => {
      if (/listening on .*\n/.test(stdout)) {
        clearTimeout(timer);
        resolve({ kind: "listening" });
      }
    };
    child.stdout.on("data", onData);
    exited.then((code) => {
      clearTimeout(timer);
      resolve({ kind: "exit", code });
    });
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  };
  return { ...outcome, port, stop, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

function http(port, { method = "GET", path = "/health", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** A /capture request whose body is still arriving: it holds a capture slot until ended. */
function openCapture(port, token) {
  const req = httpRequest({
    host: "127.0.0.1",
    port,
    method: "POST",
    path: "/capture",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    agent: false,
  });
  const response = new Promise((resolve, reject) => {
    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    req.on("error", reject);
  });
  req.write('{"urls":');
  return { req, response };
}

async function waitFor(fn, what, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("server refuses to start without RUNTIME_WORKER_TOKEN unless explicitly opted in", async () => {
  for (const env of [
    {},
    { RUNTIME_WORKER_TOKEN: "   " }, // whitespace-only is no token
    { RUNTIME_WORKER_ALLOW_UNAUTHENTICATED: "1" }, // only exactly "true" opts in
    { RUNTIME_WORKER_ALLOW_UNAUTHENTICATED: "TRUE" },
  ]) {
    const w = await startWorker(env);
    try {
      assert.equal(w.kind, "exit", `${JSON.stringify(env)}: must not listen (${w.stdout.trim()})`);
      assert.equal(w.code, 1, JSON.stringify(env));
      assert.match(w.stderr, /RUNTIME_WORKER_TOKEN is not set/);
      assert.match(w.stderr, /RUNTIME_WORKER_ALLOW_UNAUTHENTICATED=true/);
    } finally {
      await w.stop();
    }
  }
});

test("the unauthenticated opt-in binds 127.0.0.1 only", async () => {
  const w = await startWorker({ RUNTIME_WORKER_ALLOW_UNAUTHENTICATED: "true" });
  try {
    assert.equal(w.kind, "listening", w.stderr);
    assert.match(w.stdout, new RegExp(`listening on 127\\.0\\.0\\.1, port ${w.port}\\b`));
    const health = await http(w.port);
    assert.equal(health.status, 200);
    assert.equal(health.json.authRequired, false);
    // Not reachable on any other local interface. Only a completed TCP connect is a failure:
    // a refusal or no answer at all (a filtered network) both mean nothing is listening there.
    const external = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal);
    if (external) {
      const outcome = await new Promise((resolve) => {
        const sock = netConnect({ host: external.address, port: w.port });
        const timer = setTimeout(() => { sock.destroy(); resolve("no answer"); }, 2000);
        sock.on("connect", () => { clearTimeout(timer); sock.destroy(); resolve("connected"); });
        sock.on("error", () => { clearTimeout(timer); resolve("refused"); });
      });
      assert.notEqual(outcome, "connected", `${external.address}:${w.port} must not accept connections`);
    }
  } finally {
    await w.stop();
  }
});

test("with a token the server listens on all interfaces and requires the bearer", async () => {
  const w = await startWorker({ RUNTIME_WORKER_TOKEN: "s3cret-token" });
  try {
    assert.equal(w.kind, "listening", w.stderr);
    assert.match(w.stdout, /listening on all interfaces/);
    assert.equal((await http(w.port)).json.authRequired, true);
    const body = '{"urls":["https://example.com/"]}';
    assert.equal((await http(w.port, { method: "POST", path: "/capture", body })).status, 401);
    const wrong = { authorization: "Bearer not-the-token" };
    assert.equal((await http(w.port, { method: "POST", path: "/capture", headers: wrong, body })).status, 401);
  } finally {
    await w.stop();
  }
});

test("captures in flight are capped: extra requests get 429 and slots are released", async () => {
  const token = "s3cret-token";
  const auth = { authorization: `Bearer ${token}` };
  const w = await startWorker({ RUNTIME_WORKER_TOKEN: token, RUNTIME_WORKER_MAX_CONCURRENT: "1" });
  const inFlight = async () => (await http(w.port)).json?.capturesInFlight;
  try {
    assert.equal(w.kind, "listening", w.stderr);
    assert.equal((await http(w.port)).json.maxConcurrent, 1);

    const first = openCapture(w.port, token);
    await waitFor(async () => (await inFlight()) === 1, "the first capture to take the slot");
    const busy = await http(w.port, { method: "POST", path: "/capture", headers: auth, body: "{}" });
    assert.equal(busy.status, 429);
    assert.equal(busy.json.error, "busy");
    assert.ok(busy.headers["retry-after"]);
    // Auth is still checked first, and a rejected request never holds a slot.
    assert.equal((await http(w.port, { method: "POST", path: "/capture", body: "{}" })).status, 401);

    first.req.end("[]}"); // {"urls":[]} -> 400, then the slot frees
    assert.equal((await first.response).status, 400);
    await waitFor(async () => (await inFlight()) === 0, "the slot to be released");
    assert.equal((await http(w.port, { method: "POST", path: "/capture", headers: auth, body: "{}" })).status, 400);

    // A client that hangs up mid-request does not leak its slot.
    const aborted = openCapture(w.port, token);
    aborted.response.catch(() => {});
    await waitFor(async () => (await inFlight()) === 1, "the aborted capture to take the slot");
    aborted.req.destroy();
    await waitFor(async () => (await inFlight()) === 0, "the aborted capture's slot to be released");
    assert.equal((await http(w.port, { method: "POST", path: "/capture", headers: auth, body: "{}" })).status, 400);
  } finally {
    await w.stop();
  }
});

test("RUNTIME_WORKER_MAX_CONCURRENT: 0 or negative clamps to 1; only missing or non-numeric takes the default 2", async () => {
  // `Math.floor(0) || 2` read an explicit 0 as unset, so a worker capped at "0" ran two Chromiums.
  for (const [value, expected] of [["0", 1], ["-3", 1], ["3", 3], [undefined, 2], ["", 2], ["abc", 2]]) {
    const env = { RUNTIME_WORKER_TOKEN: "s3cret-token" };
    if (value !== undefined) env.RUNTIME_WORKER_MAX_CONCURRENT = value;
    const w = await startWorker(env);
    try {
      assert.equal(w.kind, "listening", w.stderr);
      assert.equal((await http(w.port)).json.maxConcurrent, expected, `RUNTIME_WORKER_MAX_CONCURRENT=${JSON.stringify(value)}`);
    } finally {
      await w.stop();
    }
  }
});

// ── queue-consumer.mjs: the same URL admission as HTTP mode ─────────────────

test("queue jobs go through the SSRF guard, allowlist and URL cap before any capture", async () => {
  const keys = ["RUNTIME_WORKER_ALLOWLIST", "RUNTIME_WORKER_MAX_URLS"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const { processCaptureJob } = await import("./queue-consumer.mjs");
  const job = (urls) => processCaptureJob({ kind: "runtime_capture", urls });
  try {
    delete process.env.RUNTIME_WORKER_MAX_URLS;
    process.env.RUNTIME_WORKER_ALLOWLIST = "example.com";
    await assert.rejects(job(["https://evil.test/"]), { message: /^url_not_allowed: https:\/\/evil\.test\// });
    await assert.rejects(job(["https://example.com/", "https://notexample.com/"]), { message: /^url_not_allowed: / });
    await assert.rejects(job(Array(11).fill("https://example.com/")), { message: /^too_many_urls: / });
    await assert.rejects(job([]), { message: /^bad_request: / });
    await assert.rejects(job(undefined), { message: /^bad_request: / });
    // No allowlist: private and metadata targets are still refused.
    process.env.RUNTIME_WORKER_ALLOWLIST = "";
    await assert.rejects(job(["http://169.254.169.254/latest/meta-data/"]), { message: /^url_not_allowed: / });
    await assert.rejects(job(["http://127.0.0.1:8080/"]), { message: /^url_not_allowed: / });
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
