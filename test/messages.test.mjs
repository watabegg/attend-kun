import assert from "node:assert/strict";
import test from "node:test";

import {
  PUNCH_TYPES,
  PUNCH_MESSAGES,
  isPunchType,
  messageForPunch,
} from "../dist/messages.js";

test("every punch type maps to its Japanese message", () => {
  assert.deepEqual(PUNCH_TYPES, ["start", "end", "break", "resume"]);
  assert.equal(messageForPunch("start"), "開始します");
  assert.equal(messageForPunch("end"), "終了します");
  assert.equal(messageForPunch("break"), "中断します");
  assert.equal(messageForPunch("resume"), "再開します");
});

test("isPunchType guards unknown input", () => {
  assert.equal(isPunchType("start"), true);
  assert.equal(isPunchType("lunch"), false);
  assert.equal(isPunchType(undefined), false);
  assert.equal(isPunchType(42), false);
});

test("PUNCH_MESSAGES covers exactly the known types", () => {
  assert.deepEqual(Object.keys(PUNCH_MESSAGES).sort(), [...PUNCH_TYPES].sort());
});
