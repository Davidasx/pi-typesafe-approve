import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POLICY, POLICY_FILE_NAME, loadPolicy, policyPath } from "../src/policy.ts";

function context(env: Record<string, string | undefined> = {}) {
  const configDir = join(mkdtempSync(join(tmpdir(), "tsa-policy-")), "pi-typesafe-approve");
  return { configDir, env };
}

test("the policy is created from the default when the file is absent", () => {
  const ctx = context();
  const loaded = loadPolicy(ctx);

  assert.equal(loaded.created, true);
  assert.equal(loaded.fallback, false);
  assert.equal(loaded.path, join(ctx.configDir, POLICY_FILE_NAME));
  assert.equal(loaded.text, DEFAULT_POLICY.trim());

  // Written to disk owner-only, and stable on the next read.
  assert.equal(statSync(loaded.path).mode & 0o777, 0o600);
  const again = loadPolicy(ctx);
  assert.equal(again.created, false);
  assert.equal(again.text, DEFAULT_POLICY.trim());
});

test("an existing policy is used verbatim, not the default", () => {
  const ctx = context();
  const path = policyPath(ctx);
  mkdirSync(ctx.configDir, { recursive: true });
  writeFileSync(path, "  my own rules\n");

  const loaded = loadPolicy(ctx);
  assert.equal(loaded.created, false);
  assert.equal(loaded.fallback, false);
  assert.equal(loaded.text, "my own rules");
});

test("an existing but empty file is never overwritten", () => {
  const ctx = context();
  const path = policyPath(ctx);
  mkdirSync(ctx.configDir, { recursive: true });
  writeFileSync(path, "   \n\n");

  const loaded = loadPolicy(ctx);
  // The default is used in memory so the reviewer still has rules, and the
  // caller is told — but the file is left alone, because it may be a policy
  // someone is midway through rewriting.
  assert.equal(loaded.created, false);
  assert.equal(loaded.fallback, true);
  assert.equal(loaded.text, DEFAULT_POLICY.trim());
  assert.equal(readFileSync(path, "utf8"), "   \n\n");
});

test("environment references in the policy are expanded", () => {
  const ctx = context({ PI_TMPDIR: "/tmp/session-scratch" });
  const path = policyPath(ctx);
  mkdirSync(ctx.configDir, { recursive: true });
  writeFileSync(path, "Temp files belong in ${PI_TMPDIR}. A literal is $HOME and $5.");

  const loaded = loadPolicy(ctx);
  assert.equal(
    loaded.text,
    "Temp files belong in /tmp/session-scratch. A literal is $HOME and $5.",
  );
  assert.deepEqual(loaded.unresolved, []);
  assert.deepEqual(loaded.bare, ["HOME"]);
});

test("unresolved references are reported and left in the text", () => {
  const ctx = context();
  const path = policyPath(ctx);
  mkdirSync(ctx.configDir, { recursive: true });
  writeFileSync(path, "A ${NOT_SET_ANYWHERE} and a ${ALSO_MISSING}.");

  const loaded = loadPolicy(ctx);
  assert.equal(loaded.text, "A ${NOT_SET_ANYWHERE} and a ${ALSO_MISSING}.");
  assert.deepEqual(loaded.unresolved, ["NOT_SET_ANYWHERE", "ALSO_MISSING"]);
});

test("the default policy stays short and mandates no working style", () => {
  // The default is what a new user gets, so it has to be small and free of
  // preferences. Both properties are behaviour, not prose: length is paid on
  // every request, and a mandated style is a false positive for everyone who
  // does not share it.
  assert.ok(
    DEFAULT_POLICY.length < 600,
    `default policy grew to ${DEFAULT_POLICY.length} chars; keep it minimal`,
  );
  assert.match(DEFAULT_POLICY, /Stop it if it would/);
  assert.match(DEFAULT_POLICY, /Anything else is fine/);

  // Exactly five numbered items, and nothing that picks a side on habits.
  assert.deepEqual(DEFAULT_POLICY.match(/^\d\./gmu), ["1.", "2.", "3.", "4.", "5."]);
  for (const style of ["sudo", "git", "/tmp", "PI_TMPDIR", "package manager", "AGENTS.md"]) {
    assert.ok(
      !DEFAULT_POLICY.includes(style),
      `default policy must not mandate anything about ${style}`,
    );
  }
});

test("the created file is the default policy, byte for byte", () => {
  const ctx = context();
  const loaded = loadPolicy(ctx);
  assert.equal(readFileSync(loaded.path, "utf8"), DEFAULT_POLICY);
});
