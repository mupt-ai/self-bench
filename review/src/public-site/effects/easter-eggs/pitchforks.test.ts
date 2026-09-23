import { expect, test } from "bun:test";
import { summonsMob } from "./pitchforks";

test("typing the command summons a mob", () => {
  expect(summonsMob("/pitchfork", "/pitchforks")).toBe(true);
  expect(summonsMob("", "/pitchforks")).toBe(true);
});

test("edits that keep the command whole do not summon another", () => {
  expect(summonsMob("/pitchforks", "/pitchforks ")).toBe(false);
  expect(summonsMob("/pitchforks ", "/pitchforks")).toBe(false);
});

test("deleting into the command and retyping it summons again", () => {
  expect(summonsMob("/pitchforks", "/pitchfork")).toBe(false);
  expect(summonsMob("/pitchfork", "/pitchforks")).toBe(true);
});

test("clearing the box never summons", () => {
  expect(summonsMob("/pitchforks", "")).toBe(false);
});
