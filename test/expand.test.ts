import { test } from "node:test";
import assert from "node:assert/strict";
import {
  expandVariables,
  findBareReferences,
  findReferences,
  findUnsupported,
  findUnresolved,
} from "../src/expand.ts";

test("a braced reference expands from the environment", () => {
  assert.equal(expandVariables("dir=${HOME}/x", { env: { HOME: "/home/u" } }), "dir=/home/u/x");
});

test("case carries no meaning", () => {
  const env = { home: "/lower", HOME: "/upper" };
  assert.equal(expandVariables("${home} ${HOME}", { env }), "/lower /upper");
});

test("a bare $word is a literal, not a reference", () => {
  const env = { HOME: "/home/u" };
  assert.equal(expandVariables("$HOME and ${HOME}", { env }), "$HOME and /home/u");
});

test("no escape syntax is needed for a literal dollar", () => {
  const env = { HOME: "/home/u" };
  assert.equal(expandVariables("cost is $$5 and $$HOME", { env }), "cost is $$5 and $$HOME");
  assert.equal(expandVariables("plain $ and $5 and $(cmd)", { env }), "plain $ and $5 and $(cmd)");
});

test("an unset or empty variable is left exactly as written", () => {
  assert.equal(expandVariables("a=${MISSING} b=${EMPTY}", { env: { EMPTY: "" } }), "a=${MISSING} b=${EMPTY}");
});

test("a malformed reference is a literal", () => {
  assert.equal(expandVariables("${} ${1} ${a-b}", { env: { "1": "x" } }), "${} ${1} ${a-b}");
});

test("${PWD} is the same value as $(pwd -P), not the environment variable", () => {
  // A shell's PWD is the logical path and can differ from the physical one when a
  // symlink is involved. Both spellings are documented as the working directory,
  // so both answer from the same value.
  const env = { PWD: "/home/u/Desktop/proj" };
  assert.equal(expandVariables("${PWD}", { env, cwd: "/home/u/proj" }), "/home/u/proj");
  assert.equal(expandVariables("$(pwd -P)", { env, cwd: "/home/u/proj" }), "/home/u/proj");
  assert.equal(expandVariables("$(pwd)", { env, cwd: "/home/u/proj" }), "/home/u/proj");
  // With no cwd to give, the reference is left alone rather than silently wrong.
  assert.equal(expandVariables("${PWD}", { env }), "/home/u/Desktop/proj");
});

test("${PWD} is not reported as unresolved", () => {
  assert.deepEqual(findUnresolved("${PWD} and ${MISSING}", {}), ["MISSING"]);
});

test("findReferences lists names and findUnresolved filters them", () => {
  const text = "a=${ONE} b=${ONE} c=${TWO} d=$BARE";
  assert.deepEqual(findReferences(text), ["ONE", "ONE", "TWO"]);
  assert.deepEqual(findUnresolved(text, { ONE: "1" }), ["TWO"]);
});

test("findBareReferences spots habitual $word use without flagging ${word}", () => {
  assert.deepEqual(findBareReferences("$HOME ${HOME} $PATH ${PATH}"), ["HOME", "PATH"]);
  assert.deepEqual(findBareReferences("${PATH}"), []);
  assert.deepEqual(findBareReferences("$5 $(cmd)"), []);
  // `$$x` has a bare `$x` in it, and the detector only needs to be a hint.
  assert.deepEqual(findBareReferences("$$x"), ["x"]);
});
