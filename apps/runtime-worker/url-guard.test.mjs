// SSRF guard unit tests. Run with: node --test url-guard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
