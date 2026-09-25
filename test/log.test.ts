import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOG_KEEP_BYTES,
  LOG_MAX_BYTES,
  createFileLogger,
  trimLogFile,
} from "../src/log.ts";

function scratch(): string {
  return join(mkdtempSync(join(tmpdir(), "tsa-log-")), "decisions.jsonl");
}

/** `count` lines, each `width` bytes including its newline. */
function lines(count: number, width: number): string {
  return Array.from({ length: count }, (_, i) => `L${i}`.padEnd(width - 1, "x")).join("\n").concat("\n");
}

test("the fixed sizes are 20 MB, keeping the newest half", () => {
  assert.equal(LOG_MAX_BYTES, 20 * 1024 * 1024);
  assert.equal(LOG_KEEP_BYTES, 10 * 1024 * 1024);
});

test("a log under the cap is left alone", () => {
  const path = scratch();
  const content = lines(10, 21);
  writeFileSync(path, content);

  trimLogFile(path, 1000, 500);
  assert.equal(readFileSync(path, "utf8"), content);
});

test("a log over the cap keeps the newest content, whole lines only", () => {
  const path = scratch();
  // 100 lines of 21 bytes = 2100 bytes, cap 1000, keep 400 → ~19 newest lines.
  writeFileSync(path, lines(100, 21));

  trimLogFile(path, 1000, 400);
  const text = readFileSync(path, "utf8");

  assert.ok(text.length <= 400, `kept ${text.length} bytes, expected at most 400`);
  assert.ok(text.endsWith("L99".padEnd(20, "x") + "\n"), "the newest line must survive");
  assert.ok(!text.startsWith("L0".padEnd(20, "x")), "the oldest line must be gone");
  // Every remaining line is complete: no half-record at the front.
  for (const line of text.trimEnd().split("\n")) {
    assert.match(line, /^L\d+x*$/, `partial line survived: ${JSON.stringify(line)}`);
  }
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("trimming leaves no temporary file behind", () => {
  const path = scratch();
  writeFileSync(path, lines(100, 21));
  trimLogFile(path, 1000, 400);
  assert.throws(() => statSync(`${path}.trim`), /ENOENT/);
});

test("a missing file is not an error", () => {
  assert.doesNotThrow(() => trimLogFile(join(tmpdir(), "tsa-does-not-exist.jsonl"), 100, 50));
});

test("a non-positive cap disables trimming", () => {
  const path = scratch();
  const content = lines(100, 21);
  writeFileSync(path, content);
  trimLogFile(path, 0, 0);
  assert.equal(readFileSync(path, "utf8"), content);
});

test("a single oversized line is kept rather than emptied", () => {
  const path = scratch();
  writeFileSync(path, "z".repeat(2000) + "\n");
  trimLogFile(path, 1000, 400);
  // No record boundary to cut at, so the window is kept as-is: non-empty, and no
  // bigger than the keep size.
  const text = readFileSync(path, "utf8");
  assert.ok(text.length > 0, "must not empty the file");
  assert.ok(text.length <= 400, `kept ${text.length} bytes, expected at most 400`);
});

test("the logger trims as it writes, and keeps writing valid records", () => {
  const path = scratch();
  const logger = createFileLogger(path, () => false, 400, 160);

  for (let i = 0; i < 200; i++) {
    logger.record({
      time: new Date(2_000_000 + i * 1000).toISOString(),
      command: `command-number-${i}`,
      cwd: "/work",
      verdict: "allow",
      action: "allow",
      reasons: [],
      signals: {},
    });
  }

  const text = readFileSync(path, "utf8");
  const rows = text.trimEnd().split("\n").map((line) => JSON.parse(line) as { command: string });

  assert.ok(rows.length > 0);
  for (const row of rows) assert.match(row.command, /^command-number-\d+$/);
  // The newest write is present and the oldest ones were dropped.
  assert.equal(rows.at(-1)?.command, "command-number-199");
  assert.ok(!rows.some((row) => row.command === "command-number-0"));
});

test("debug lines are written only when enabled, and trimmed like the rest", () => {
  const path = scratch();
  let enabled = false;
  const logger = createFileLogger(path, () => enabled, 10_000, 5_000);

  logger.debug("skipped");
  assert.throws(() => statSync(path), /ENOENT/);

  enabled = true;
  logger.debug("kept", { detail: 1 });
  assert.match(readFileSync(path, "utf8"), /"debug":"kept","detail":1/);
});
