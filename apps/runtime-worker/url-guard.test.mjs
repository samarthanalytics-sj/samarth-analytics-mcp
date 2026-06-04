// SSRF guard unit tests. Run with: node --test url-guard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { urlAllowed } from "./url-guard.mjs";

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
