import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normWords, isEcho, isStopCommand, stopInPartial, isDuplicateStop, isLateEcho,
  medianOf, isNearVoice, learnLevel, encodeWav, approvalDecision, settle, planChunks,
} from "../voicecore.js";

const q = "Posso rodar um comando: git status?";

test("normWords tira acentos e pontuação", () => {
  assert.deepEqual(normWords("Não, PARE já!"), ["nao", "pare", "ja"]);
});

test("isStopCommand", () => {
  assert.equal(isStopCommand("pare claude", ""), true);
  assert.equal(isStopCommand("pare de falar", ""), true);
  assert.equal(isStopCommand("chega", ""), true);
  assert.equal(isStopCommand("pare smith", ""), false);
  assert.equal(isStopCommand("vou parar o servidor agora", ""), false);
  assert.equal(isStopCommand("pare", "não pare nunca"), false);
});

test("só pare e chega são comandos de parada", () => {
  for (const w of ["para", "parar", "stop", "silencio", "cala"]) assert.equal(isStopCommand(w, ""), false, w);
});

test("pare vale mesmo quando a resposta tem a preposição para", () => {
  const falando = "Para fazer o rebase, você reaplica os commits um a um.";
  assert.equal(isStopCommand("pare", falando), true);
  assert.equal(isStopCommand("chega", falando), true);
});

test("stopInPartial olha a cauda", () => {
  assert.equal(stopInPartial("isso aqui está errado pare", "", ""), true);
  assert.equal(stopInPartial("isso aqui está errado para", "", ""), false);
});

test("isEcho", () => {
  assert.equal(isEcho("vou olhar os arquivos", "Vou olhar os arquivos."), true);
  assert.equal(isEcho("roda os testes de novo", "Vou olhar os arquivos."), false);
  assert.equal(isEcho("", "qualquer"), true);
});

test("isLateEcho respeita a janela", () => {
  assert.equal(isLateEcho("olhar os arquivos", "Vou olhar os arquivos.", 100, 200), true);
  assert.equal(isLateEcho("olhar os arquivos", "Vou olhar os arquivos.", 300, 200), false);
});

test("isDuplicateStop", () => {
  assert.equal(isDuplicateStop(5000, 2000), true);
  assert.equal(isDuplicateStop(7000, 2000), false);
  assert.equal(isDuplicateStop(100, 0), false);
});

test("proximidade", () => {
  assert.equal(medianOf([3, 1, 2]), 2);
  assert.equal(isNearVoice(0.01, [0.1, 0.1, 0.1], 45), false);
  assert.equal(isNearVoice(0.05, [0.1, 0.1, 0.1], 45), true);
  assert.equal(isNearVoice(0.01, [0.1, 0.1], 45), true);
  assert.equal(learnLevel(Array(12).fill(1), 2).length, 12);
});

test("encodeWav monta cabeçalho PCM16", () => {
  const buf = new DataView(encodeWav(new Float32Array([0, 1, -1]), 16000));
  assert.equal(buf.byteLength, 50);
  assert.equal(buf.getUint32(24, true), 16000);
  assert.equal(buf.getInt16(46, true), 32767);
  assert.equal(buf.getInt16(48, true), -32768);
});

test("approvalDecision", () => {
  assert.equal(approvalDecision("sim pode", q, false), "answer");
  assert.equal(approvalDecision("sim pode", q, true), "ignore");
  assert.equal(approvalDecision("cancela", q, false), "deny");
  assert.equal(approvalDecision("pare claude", q, false), "deny");
  assert.equal(approvalDecision("chega", q, false), "deny");
  assert.equal(approvalDecision("para", q, false), "other");
  assert.equal(approvalDecision("roda o git status", q, false), "other");
  assert.equal(approvalDecision("posso rodar um comando", q, false), "other");
});

import { Failures } from "../voicecore.js";

test("Failures desiste depois de N falhas seguidas", () => {
  const f = new Failures(3);
  assert.equal(f.fail(), false);
  assert.equal(f.fail(), false);
  f.ok();
  assert.equal(f.fail(), false);
  assert.equal(f.fail(), false);
  assert.equal(f.fail(), true);
});

import { LevelWindow } from "../voicecore.js";

test("LevelWindow guarda o pico da fala, não a leitura do instante", () => {
  const w = new LevelWindow(8000);
  w.add(0, 0.01);
  w.add(100, 0.2);
  w.add(200, 0.005);
  assert.equal(w.peak(200), 0.2);
});

test("LevelWindow esquece o que veio antes do reinício", () => {
  const w = new LevelWindow(8000);
  w.add(0, 0.3);
  w.reset(50);
  w.add(100, 0.1);
  assert.equal(w.peak(100), 0.1);
});

test("LevelWindow esquece o que passou da janela", () => {
  const w = new LevelWindow(1000);
  w.add(0, 0.3);
  w.add(1500, 0.1);
  assert.equal(w.peak(1500), 0.1);
  assert.equal(new LevelWindow(1000).peak(0), 0);
});

test("settle: bloco com id que acaba de tocar vira done", () => {
  assert.deepEqual(settle(["a", null, "b"], { type: "done", id: "a" }),
    { spoken: [{ type: "spoken", id: "a", outcome: "done" }], pending: [null, "b"] });
});

test("settle: bloco sem id não reporta nada", () => {
  assert.deepEqual(settle([null], { type: "done", id: null }), { spoken: [], pending: [null] });
});

test("settle: flush com 2 blocos pendentes dá 2 stopped", () => {
  assert.deepEqual(settle(["a", null, "b"], { type: "stop" }), {
    spoken: [
      { type: "spoken", id: "a", outcome: "stopped" },
      { type: "spoken", id: "b", outcome: "stopped" },
    ],
    pending: [],
  });
});

test("settle: não mexe na lista de entrada", () => {
  const queue = ["a"];
  settle(queue, { type: "stop" });
  assert.deepEqual(queue, ["a"]);
});

test("planChunks: bloco em branco com id fica na ordem (lead/tail)", () => {
  assert.deepEqual(planChunks(["  ", "um", "", "dois", " "], ["x", "a", "y", null, "z"]), {
    chunks: ["um", "dois"], ids: ["a", null], lead: [["x"], ["y"]], tail: ["z"],
  });
});

test("planChunks: sem ids", () => {
  assert.deepEqual(planChunks(["um", ""], null), { chunks: ["um"], ids: [null], lead: [[]], tail: [] });
});

test("settle: fail (página sem voz ativa) dá failed para cada id (R23)", () => {
  assert.deepEqual(settle(["a", null, "b"], { type: "fail" }), {
    spoken: [
      { type: "spoken", id: "a", outcome: "failed" },
      { type: "spoken", id: "b", outcome: "failed" },
    ],
    pending: [],
  });
});
