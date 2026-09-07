#!/usr/bin/env python3
"""Roda o self-test do spike de PTY sob um terminal de verdade.

O Node não aloca pty sozinho, então o wrapper precisa de alguém que faça esse
papel de "terminal do usuário": abrir um pty, definir o tamanho e, no meio da
sessão, redimensionar — que é o cenário que quebra qualquer wrapper mal feito.
"""

import fcntl
import os
import pty
import select
import struct
import sys
import termios
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOOT = (137, 41)
RESIZED = (100, 30)
TIMEOUT_SECONDS = 90


def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main():
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(REPO)
        env = dict(os.environ, TERM="xterm-256color")
        os.execvpe(
            "node",
            ["node", "--experimental-strip-types", "spikes/pty-rename.ts", "--self-test"],
            env,
        )

    set_size(fd, *BOOT)

    output = b""
    resized = False
    deadline = time.time() + TIMEOUT_SECONDS
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            output += chunk
            sys.stdout.write(chunk.decode("utf8", "replace"))
            sys.stdout.flush()
        if not resized and b"SPIKE:awaiting-resize" in output:
            resized = True
            set_size(fd, *RESIZED)
        if b"SPIKE:done" in output:
            break

    status = 0
    for _ in range(50):
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            break
        time.sleep(0.1)
    else:
        os.kill(pid, 9)
        os.waitpid(pid, 0)

    if b"SPIKE:done" not in output:
        print("\nharness: spike não terminou dentro do tempo", file=sys.stderr)
        return 1
    if b"SPIKE:FAIL" in output:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
