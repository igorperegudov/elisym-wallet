/** Bin entry point: `elisym-wallet` -> dist/cli.js. All logic lives in cli.ts. */

import process from 'node:process';
import { runCli } from './cli.js';

runCli(process.argv.slice(2)).then((code) => {
  // Exit explicitly instead of waiting for the event loop to drain, so stray
  // RPC sockets/timers never delay the prompt after a command finished. All
  // command output is written and awaited before runCli resolves.
  //
  // Known limit: with an UNREACHABLE rpc-url the error prints at the network
  // timeout (~10s) but the OS process can take ~20s more to die - a connect()
  // blocked in Node's threadpool stalls teardown even after process.exit()
  // (verified with --trace-exit). Upstream Node/undici behavior; harmless
  // beyond the wait.
  process.exit(code);
});
