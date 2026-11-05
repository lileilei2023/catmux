"""Local stdlib-only PTY adapter. Runs only the selected SSH/tssh client.

No sockets, native Node module, configuration/credential reads or AI execution.
stdin/stdout use bounded JSON control/events. The child's terminal is a real PTY.
"""
import base64
import errno
import fcntl
import json
import os
import pty
import select
import time
import signal
import struct
import sys
import termios


def emit(event):
    sys.stdout.write(json.dumps(event, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main():
    command = sys.argv[1:]
    if not command or not os.path.isabs(command[0]):
        raise RuntimeError("absolute SSH executable required")
    pid, master = pty.fork()
    if pid == 0:
        os.execve(command[0], command, os.environ)

    def terminate(_signal=None, _frame=None):
        try:
            os.killpg(pid, signal.SIGHUP)
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 28, 100, 0, 0))
    pending = b""
    input_open, terminal_open = True, True
    try:
        while terminal_open:
            readable, _, _ = select.select(([master] if terminal_open else []) + ([0] if input_open else []), [], [], 0.2)
            if master in readable:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    data = b""
                if data:
                    # A full-screen redraw often arrives in several reads. Gather
                    # what follows within ~4 ms (max 16 ms / 256 KiB) so one frame
                    # reaches the browser together instead of half-painted.
                    deadline = time.monotonic() + 0.016
                    while len(data) < 262144 and time.monotonic() < deadline:
                        more, _, _ = select.select([master], [], [], 0.004)
                        if not more:
                            break
                        try:
                            chunk = os.read(master, 65536)
                        except OSError as error:
                            if error.errno != errno.EIO:
                                raise
                            chunk = b""
                        if not chunk:
                            terminal_open = False
                            break
                        data += chunk
                    emit({"type": "data", "data": base64.b64encode(data).decode("ascii")})
                else:
                    terminal_open = False
            if 0 in readable:
                data = os.read(0, 65536)
                if not data:
                    input_open = False
                    terminate()
                pending += data
                if len(pending) > 262144:
                    raise RuntimeError("PTY control message too large")
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    message = json.loads(line)
                    op = message.get("type")
                    if op == "write":
                        raw = base64.b64decode(message["data"], validate=True)
                        if len(raw) > 65536:
                            raise RuntimeError("PTY input too large")
                        offset = 0
                        while offset < len(raw):
                            offset += os.write(master, raw[offset:])
                    elif op == "resize":
                        cols, rows = message["cols"], message["rows"]
                        if not isinstance(cols, int) or not isinstance(rows, int) or not 2 <= cols <= 500 or not 2 <= rows <= 200:
                            raise RuntimeError("invalid PTY dimensions")
                        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
                    elif op == "close":
                        terminate()
                    else:
                        raise RuntimeError("unknown PTY control operation")
        _, status = os.waitpid(pid, 0)
        emit({"type": "exit", "code": os.waitstatus_to_exitcode(status)})
    finally:
        terminate()
        os.close(master)


if __name__ == "__main__":
    try:
        main()
    except (BrokenPipeError, KeyboardInterrupt):
        pass
    except Exception as error:
        emit({"type": "error", "error": str(error)})
        sys.exit(1)
