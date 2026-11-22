import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);
const nativeOnly = process.argv.includes("--native-only");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const posts = [];
let healthy = false;
const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404); res.end(); return;
  }
  let raw = "";
  for await (const part of req) raw += part;
  const body = JSON.parse(raw);
  const status = healthy ? 200 : 503;
  const users = body.messages.filter(m => m.role === "user").flatMap(m => typeof m.content === "string"
    ? [m.content] : m.content.filter(block => block.type === "text").map(block => block.text));
  posts.push({ status, model: body.model,
    users: users.filter(text => text === "CANCELLED_NATIVE_TURN" || text === "NEW_TURN_AFTER_DENIAL") });
  res.writeHead(status, { "content-type": healthy ? "text/event-stream" : "text/html", "retry-after": "0" });
  res.end(healthy
    ? `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "main",
      choices: [{ index: 0, delta: { role: "assistant", content: "FRESH_TURN_OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
    : "<html><body>503 Service Unavailable</body></html>");
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const port = server.address().port;
const work = await mkdtemp(join(tmpdir(), "pvp-gate-cancel-"));
const agentDir = join(work, "agent");
await mkdir(agentDir);
await writeFile(join(agentDir, "config.yml"), JSON.stringify({
  modelRoles: { default: "gate-cancel-fixture/main" }, retry: { enabled: false },
}));
const command = process.env.OMP_EXECUTABLE ?? process.execPath;
const args = [
  ...(process.env.OMP_EXECUTABLE ? [] : [join(repo, "node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js")]),
  "--mode", "rpc", "--no-extensions", "--no-skills", "--no-tools", "--no-session", "--no-rules",
  "-e", join(repo, "src/index.ts"), "-e", join(here, "gate-cancel-host.ts"), "--thinking", "off",
];
const child = spawn(command, args, { cwd: work, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: {
  ...process.env, PI_CODING_AGENT_DIR: agentDir, PVP_GATE_CANCEL_URL: `http://127.0.0.1:${port}/v1`,
  PVP_GATE_CANCEL_NATIVE_ONLY: nativeOnly ? "1" : "0",
  PI_OFFLINE: "1", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "127.0.0.1,localhost",
} });
let stdout = "", stderr = "", partial = "", spawnError;
const frames = [];
child.stdout.on("data", chunk => {
  const text = String(chunk); stdout += text; partial += text;
  const lines = partial.split("\n"); partial = lines.pop();
  for (const line of lines) {
    try { frames.push(JSON.parse(line)); } catch { /* Non-protocol diagnostics remain in captured stdout. */ }
  }
});
child.stderr.on("data", chunk => { stderr += String(chunk); });
const closed = new Promise(resolve => {
  child.once("error", error => { spawnError = error; resolve(); });
  child.once("close", resolve);
});
async function until(test, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = test(); if (result) return result;
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`CLI exited before ${label}`);
    if (posts.length > 20) throw new Error(`Retry flood before ${label}`);
    await pause(20);
  }
  throw new Error(`Timeout waiting for ${label}`);
}
let sequence = 0;
async function rpc(type, data = {}) {
  const id = `gate-cancel-${++sequence}`;
  child.stdin.write(JSON.stringify({ id, type, ...data }) + "\n");
  const reply = await until(() => frames.find(frame => frame.type === "response" && frame.id === id), `${type} ack`);
  assert.equal(reply.success, true, `${type} rejected`);
  return { id, reply };
}
const prompt = message => rpc("prompt", { message });
async function settled(id) {
  const result = await until(() => frames.find(frame => frame.type === "prompt_result" && frame.id === id), "cancelled native prompt_result");
  assert.equal(result.agentInvoked, true, "Prompt must reach the actual agent");
  assert.equal(result.sessionSettled, true, "Native session must settle, not just acknowledge the command");
  assert.equal((await rpc("get_state")).reply.data.isStreaming, false, "Native session must become idle");
  return result;
}
const evidence = process.env.PVP_GATE_CANCEL_EVIDENCE
  ? `${process.env.PVP_GATE_CANCEL_EVIDENCE}${nativeOnly ? "-native" : ""}`
  : undefined;
let failure;
try {
  await until(() => stderr.includes("GATE_CANCEL_EVENT ready"), "real host ready");
  console.log(`READY command=${command} pid=${child.pid} port=${port}`);
  await prompt("/pvp on");
  const cancelled = await prompt("CANCELLED_NATIVE_TURN");
  await until(() => stderr.includes("GATE_CANCEL_EVENT parked"), "parked protocol gate");
  const parkedPosts = posts.length;
  await prompt("/gate-deny");
  await until(() => stderr.includes("GATE_CANCEL_EVENT denied"), "false gate decision");
  const result = await settled(cancelled.id);
  healthy = true;
  await pause(2500);
  assert.equal(posts.length, parkedPosts, "Recovery must not revive the cancelled request");
  const fresh = await prompt("NEW_TURN_AFTER_DENIAL");
  const freshResult = await settled(fresh.id);
  assert.equal(freshResult.status, "completed", "Cancellation must not abort a later prompt");
  assert.equal(posts.length, parkedPosts + 1, "Only the fresh request may reach the recovered API");
  assert.equal(posts.at(-1).status, 200);
  assert.equal(posts.at(-1).users.filter(text => text === "NEW_TURN_AFTER_DENIAL").length, 1, "Fresh user prompt must not be duplicated");
  assert.ok(frames.some(frame => frame.type === "message_end" && frame.message?.role === "assistant"
    && frame.message.content?.some(block => block.type === "text" && block.text.includes("FRESH_TURN_OK"))), "Fresh request must produce a real fixture response");
  console.log(JSON.stringify({ result: "PASS", mode: nativeOnly ? "native" : "request", cancelled: result, fresh: freshResult, posts }));
} catch (error) {
  failure = error;
  console.error(JSON.stringify({ result: "FAIL", error: error.message, posts,
    promptResults: frames.filter(frame => frame.type === "prompt_result") }));
} finally {
  child.stdin.end();
  await Promise.race([closed, pause(3000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([closed, pause(5000)]); }
  let pidGone = !child.pid;
  if (child.pid) { try { process.kill(child.pid, 0); } catch { pidGone = true; } }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  const portRefused = await new Promise(resolve => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(true));
  });
  console.log(JSON.stringify({ cleanup: true, pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, pidGone, port, portRefused }));
  if (evidence) {
    await writeFile(`${evidence}.stdout.log`, stdout);
    await writeFile(`${evidence}.stderr.log`, stderr);
  }
  await rm(work, { recursive: true, force: true });
  assert.equal(pidGone, true, "Fixture CLI must exit");
  assert.equal(portRefused, true, "Fixture HTTP listener must close");
  if (!failure) assert.equal(child.exitCode, 0, "Fixture CLI must exit cleanly");
}
if (failure) throw failure;
