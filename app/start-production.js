/**
 * Production supervisor for the single Fly.io machine that runs BOTH the
 * Remix web server and the catalog-audit background worker side by side.
 *
 * Why this exists: this deploy is one always-on machine with one SQLite
 * database on a Fly volume mounted at /data. There is no separate worker
 * machine and no Fly `release_command` — migrations only make sense to run
 * on this machine (it is the only one with the volume attached), and the
 * worker only makes sense running here too (same filesystem, same DB).
 *
 * Boot sequence:
 *   1. `prisma migrate deploy` against the SQLite DB on /data. If this
 *      fails, the machine must not come up serving traffic against an
 *      un-migrated (or partially migrated) database, so we abort before
 *      starting anything else.
 *   2. Start the web server (`remix-serve build/server/index.js`) and the
 *      worker (`node build/worker.js`, an esbuild bundle of worker.ts — see
 *      the `build:worker` script) as sibling child processes with stdio
 *      inherited, so both show up in `fly logs`.
 *
 * Supervision contract: this is deliberately NOT a process manager that
 * tries to keep things alive forever. If EITHER child exits, for ANY
 * reason, we stop the other child and exit this process with a non-zero
 * code. Fly's machine supervisor is configured (no `[processes]` block,
 * `auto_stop_machines = false`) to treat this container as the whole
 * machine, so a non-zero exit here causes Fly to restart the machine,
 * which re-runs migrate deploy and restarts both processes together.
 * Silently restarting just one of the two child processes in place would
 * risk them drifting (e.g. worker stuck on a bad Prisma client version)
 * without ever surfacing as a Fly-visible restart/alert.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function bin(name) {
  return path.join(__dirname, "node_modules", ".bin", name);
}

/** Runs a command to completion, inheriting stdio. Resolves on exit code 0. */
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", (err) => {
      reject(new Error(`failed to start ${command}: ${err.message}`));
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} was killed by ${signal}`));
      } else if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

async function migrate() {
  console.log("[supervisor] running `prisma migrate deploy`");
  await run(bin("prisma"), ["migrate", "deploy"]);
  console.log("[supervisor] migrations applied");
}

function spawnChild(name, command, args) {
  console.log(`[supervisor] starting ${name}: ${command} ${args.join(" ")}`);
  const child = spawn(command, args, { stdio: "inherit" });
  child.on("error", (err) => {
    console.error(`[supervisor] failed to start ${name}:`, err);
  });
  return child;
}

async function main() {
  try {
    await migrate();
  } catch (err) {
    console.error("[supervisor] `prisma migrate deploy` failed; not starting web/worker", err);
    process.exit(1);
  }

  const children = {
    web: spawnChild("web", bin("remix-serve"), ["./build/server/index.js"]),
    worker: spawnChild("worker", process.execPath, ["build/worker.js"]),
  };

  let shuttingDown = false;
  let exitCode = 0;
  let pendingExits = Object.keys(children).length;

  function stopAll(signal) {
    for (const child of Object.values(children)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    }
    // Fallback in case a child ignores the signal (e.g. stuck in a
    // non-interruptible operation) — force the machine restart anyway
    // rather than hang forever.
    setTimeout(() => process.exit(exitCode), 5000).unref();
  }

  function onChildExit(name, code, signal) {
    if (!shuttingDown) {
      // This child died on its own — not part of a supervisor-initiated
      // shutdown. Treat it as fatal for the whole machine.
      shuttingDown = true;
      exitCode = 1;
      console.error(
        `[supervisor] ${name} exited unexpectedly (code=${code}, signal=${signal}); ` +
          "stopping the other process and exiting non-zero so Fly restarts the machine",
      );
      stopAll("SIGTERM");
    }

    pendingExits -= 1;
    if (pendingExits === 0) {
      process.exit(exitCode);
    }
  }

  children.web.on("exit", (code, signal) => onChildExit("web", code, signal));
  children.worker.on("exit", (code, signal) => onChildExit("worker", code, signal));

  function forwardSignal(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[supervisor] received ${signal}; forwarding to web and worker`);
    stopAll(signal);
  }

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));
}

main();
