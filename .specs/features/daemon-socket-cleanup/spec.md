# daemon-socket-cleanup
Goal: a daemon removes only the socket and pid file it created, and tests stop leaving started daemons behind.
Out of scope: re-listening when the socket file disappears at runtime; any change to getPaths/paths.ts; the instance lock; any other shutdown step (drain order, checkpoint, killTree). Preserving a foreign file at the bound socket path: libuv unlinks the bound path on server.close(), and the instance lock allows one daemon per directory.
- R1: WHEN the daemon shuts down after start() THEN it SHALL unlink the socket and pid paths resolved during start(), even if CODEDECK_DIR changed since.
- R2: removed.
- R3: WHEN the daemon shuts down without having completed start() THEN it SHALL unlink no socket or pid file.
- R4: every test that calls daemon.start() SHALL close its server and neutralize its signal handlers before the test context restores CODEDECK_DIR.
Coverage matrix:
| layer | test type | where | command |
| daemon shutdown cleanup | unit, real start() in temp dir | tests/daemon-socket-cleanup.test.ts (new) | env -u CODEDECK_DIR HOME=$(mktemp -d) scripts/run-isolated.sh npx vitest run <file> |
| tests that start a daemon | unit | tests/daemon-web.test.ts, tests/orchestrator-usage-daemon.test.ts, tests/power-inhibit.test.ts | env -u CODEDECK_DIR HOME=$(mktemp -d) scripts/run-isolated.sh npx vitest run <file> |
| regression | unit | tests/power-shutdown.test.ts, tests/power-recover.test.ts, tests/session-subscribe.test.ts | env -u CODEDECK_DIR HOME=$(mktemp -d) scripts/run-isolated.sh npx vitest run <file> |
