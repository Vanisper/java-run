"""通过真实 POSIX PTY 执行按键、信号和终端恢复验收"""

import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time


def terminal_state(fd):
    values = termios.tcgetattr(fd)
    return values[:6] + [[value[0] if isinstance(value, bytes) else value for value in values[6]]]


def session():
    feedback = int(sys.argv[2])
    child = subprocess.Popen(json.loads(sys.argv[3]))
    # 与交互式 shell 一样留在会话中等待，不让终端 Ctrl+C 提前撤销终端
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    os.write(feedback, (json.dumps({"pid": child.pid}) + "\n").encode())
    code = child.wait()
    # macOS 会在会话结束后撤销终端；保留会话进程才能读取程序退出后的真实模式
    os.write(feedback, (json.dumps({"exitCode": code, "after": terminal_state(0)}) + "\n").encode())
    os.close(feedback)


def main():
    request = json.load(sys.stdin)
    master, slave = pty.openpty()
    size = struct.pack("HHHH", request.get("rows", 24), request.get("columns", 80), 0, 0)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, size)
    before = terminal_state(slave)
    environment = dict(os.environ)
    for name in ("CI", "NO_COLOR", "FORCE_COLOR", "TERM", "GITHUB_ACTIONS"):
        environment.pop(name, None)
    environment.update({"TERM": "xterm-256color", "LANG": "en_US.UTF-8"})
    environment.update(request.get("env", {}))

    def controlling_terminal():
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

    feedback_read, feedback_write = os.pipe()
    child = subprocess.Popen([sys.executable, __file__, "--session", str(feedback_write), json.dumps(request["command"])],
                             cwd=request["cwd"], env=environment,
                             stdin=slave, stdout=slave, stderr=slave,
                             pass_fds=(feedback_write,), preexec_fn=controlling_terminal)
    os.close(feedback_write)
    feedback = os.fdopen(feedback_read)
    output = bytearray()
    deadline = time.monotonic() + request.get("timeoutMs", 10000) / 1000
    error = None
    result = {}
    target_pid = None

    def read_output(duration=0.05):
        if time.monotonic() >= deadline:
            raise TimeoutError("真实 PTY 验收超过截止时间")
        readable, _, _ = select.select([master], [], [], min(duration, max(0, deadline - time.monotonic())))
        if readable:
            try:
                chunk = os.read(master, 65536)
                output.extend(chunk)
                if len(output) > 1024 * 1024:
                    raise RuntimeError("真实 PTY 转录超过 1 MiB")
                return bool(chunk)
            except OSError as failure:
                if failure.errno != errno.EIO:
                    raise
        return False

    def visible_output():
        text = output.decode("utf-8", "replace")
        return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)

    try:
        if not select.select([feedback], [], [], 2)[0]:
            raise TimeoutError("无法启动真实 PTY 会话")
        target_pid = json.loads(feedback.readline())["pid"]
        for step in request["steps"]:
            if "waitFor" in step:
                while step["waitFor"] not in visible_output():
                    read_output()
                    if child.poll() is not None and step["waitFor"] not in visible_output():
                        raise RuntimeError("进程退出前未出现：" + step["waitFor"])
            if "send" in step:
                os.write(master, step["send"].encode("utf-8"))
            if "signal" in step:
                os.kill(target_pid, getattr(signal, step["signal"]))
            if "columns" in step:
                size = struct.pack("HHHH", step.get("rows", 24), step["columns"], 0, 0)
                fcntl.ioctl(slave, termios.TIOCSWINSZ, size)
            if "observeMs" in step:
                until = time.monotonic() + step["observeMs"] / 1000
                while time.monotonic() < until:
                    read_output(min(0.05, until - time.monotonic()))
                if step.get("absent") and step["absent"] in visible_output():
                    raise RuntimeError("过早出现：" + step["absent"])
        while child.poll() is None:
            read_output()
        result = json.loads(feedback.readline())
        # 会话进程已记录终端模式，继续收取退出前最后一批输出
        while select.select([master], [], [], 0.05)[0]:
            if not read_output():
                break
    except Exception as failure:
        error = str(failure)
    finally:
        if child.poll() is None:
            # 先给被测 CLI 清理独立子进程组的机会，再回收整个验收会话
            if target_pid is not None:
                try:
                    os.kill(target_pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            try:
                child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=2)
        feedback.close()
        os.close(master)
        os.close(slave)
    print(json.dumps({"exitCode": result.get("exitCode", child.returncode), "transcript": output.decode("utf-8", "replace"),
                      "before": before, "after": result.get("after"), "error": error}, ensure_ascii=False))


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--session":
        session()
    else:
        main()
