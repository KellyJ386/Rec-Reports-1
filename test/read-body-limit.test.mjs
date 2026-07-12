import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { maxBodyBytes, readBody } from "../scripts/server.mjs";

function makeRequest(headers = {}) {
  const request = new EventEmitter();
  request.headers = headers;
  request.destroyed = false;
  request.destroy = () => {
    request.destroyed = true;
  };
  return request;
}

test("readBody resolves a small body intact", async () => {
  const request = makeRequest();
  const pending = readBody(request);
  request.emit("data", Buffer.from('{"enabled":true}'));
  request.emit("end");
  assert.equal(await pending, '{"enabled":true}');
});

test("readBody rejects and destroys the request when the declared content-length exceeds the cap", async () => {
  const request = makeRequest({ "content-length": String(maxBodyBytes + 1) });
  await assert.rejects(readBody(request), /request body too large/);
  assert.equal(request.destroyed, true);
});

test("readBody rejects and destroys the request when streamed bytes exceed the cap", async () => {
  const request = makeRequest();
  const pending = readBody(request);
  const chunk = Buffer.alloc(256 * 1024);
  request.emit("data", chunk);
  request.emit("data", chunk);
  request.emit("data", chunk);
  request.emit("data", chunk);
  request.emit("data", Buffer.alloc(1));
  await assert.rejects(pending, /request body too large/);
  assert.equal(request.destroyed, true);
});
