import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import process from "node:process";

const moduleUrls = JSON.parse(process.argv[2] ?? "[]");
const events = [];
let currentModule = null;

function record(channel, operation) {
  events.push({ channel, module: currentModule, operation: String(operation) });
}

fs.readFileSync = (...args) => {
  record("filesystem", "readFileSync");
  return args[1] === "utf8" || args[1]?.encoding === "utf8" ? "" : Buffer.alloc(0);
};
fs.writeFileSync = () => record("filesystem", "writeFileSync");
syncBuiltinESMExports();

globalThis.fetch = async () => {
  record("network", "fetch");
  return { ok: true };
};
globalThis.WebSocket = class WebSocketProbe {
  constructor() {
    record("network", "WebSocket");
  }
};
globalThis.setTimeout = () => {
  record("timer", "setTimeout");
  return 1;
};
globalThis.setInterval = () => {
  record("timer", "setInterval");
  return 1;
};
globalThis.registry = {
  register() {
    record("registry", "register");
  },
};
globalThis.__TAURI_INTERNALS__ = new Proxy({}, {
  get(_target, property) {
    return () => record("tauri", property);
  },
});

for (const [index, moduleUrl] of moduleUrls.entries()) {
  currentModule = index;
  await import(moduleUrl);
}

console.log(JSON.stringify({ events }));
