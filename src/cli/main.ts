#!/usr/bin/env node
// The `umio` executable: wires the real process into runCli.
import { runCli } from "./app.js";

const code = await runCli(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  cwd: process.cwd(),
  onSignal(signal, handler) {
    process.on(signal, handler);
    return () => process.off(signal, handler);
  },
  exit(code) {
    process.exit(code);
  },
});
process.exitCode = code;
// Idle keep-alive sockets (provider clients) must not hold the process open.
setTimeout(() => process.exit(code), 2_000).unref();
