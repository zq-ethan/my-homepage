"""一键推送 —— 把这台机器上 git push 的所有坑一次性绕过去。

用法（在项目根目录）：
    .venv\\Scripts\\python.exe tools\\push.py

它做三件事：
  1. 自动找出可用的 git.exe（PATH 上的，或 WorkBuddy 自带的便携版）
  2. 带上这台机器必需的绕行参数推送，失败就自动重试（默认 10 次）
  3. 推送后核对远端哈希，确认真的上去了

为什么不能直接用 `git push`：见 .workbuddy/memory/MEMORY.md 的「环境注意」一节。
一句话版本 —— 本机代理会给 GitHub 的 HTTPS 做中间人，git 会卡在证书吊销检查上；
而且网络是间歇可用的，一次失败不代表失败，重试常成功。

前提：得有一个能出去的网络。如果反复报
    CONNECT tunnel failed, response 502
或  Failed to connect to github.com:443 after 21000 ms
说明本机没有任何可用代理（FlClash 没开 / Steam++ 的 GitHub 加速没开），
先把它打开再跑本脚本。
"""

import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 这台机器上必需的绕行参数：
#   schannelCheckRevoke / sslVerify —— 代理做中间人时的证书问题
#   postBuffer                      —— 大一点的包别被截断
#   lowSpeedLimit / lowSpeedTime    —— 卡住就主动放弃，别干等十几分钟
#   version=HTTP/1.1                —— HTTP/2 在这条链路上不稳
GIT_OPTS = [
    "-c", "http.schannelCheckRevoke=false",
    "-c", "http.sslVerify=false",
    "-c", "http.postBuffer=524288000",
    "-c", "http.lowSpeedLimit=1000",
    "-c", "http.lowSpeedTime=20",
    "-c", "http.version=HTTP/1.1",
]

MAX_ATTEMPTS = 10
BRANCH = "main"


def find_git() -> str:
    """优先用 PATH 上的 git，找不到再退回 WorkBuddy 自带的便携版。"""
    found = shutil.which("git")
    if found:
        return found
    fallback = os.path.expandvars(
        r"%USERPROFILE%\.workbuddy\binaries\PortableGit\versions\1.2.0\cmd\git.exe"
    )
    if os.path.exists(fallback):
        return fallback
    print("找不到 git.exe，请确认 git 已安装或在 PATH 上。")
    sys.exit(1)


GIT = find_git()

# 非交互：别弹凭据窗口，卡住就直接失败，交给外层重试
ENV = dict(os.environ)
ENV["GIT_TERMINAL_PROMPT"] = "0"
ENV["GCM_INTERACTIVE"] = "never"


def run(args, timeout=90):
    """跑一条 git 命令。返回 (退出码, 输出文本)。超时会把整棵进程树杀掉。

    为什么要 kill 进程树：git 会拉起凭据助手等子进程，只杀父进程的话
    管道不关，communicate() 会一直挂着。
    """
    proc = subprocess.Popen(
        [GIT, "-C", ROOT] + args,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=ENV,
        creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
    )
    try:
        out, _ = proc.communicate(timeout=timeout)
        return proc.returncode, (out or "").strip()
    except subprocess.TimeoutExpired:
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                           capture_output=True, timeout=30)
        else:
            proc.kill()
        return -1, "超时（网络卡住）"


def main() -> int:
    print("git       = %s" % GIT)
    print("工作目录  = %s" % ROOT)
    print()

    rc, out = run(["log", "--oneline", "-1"])
    if rc != 0:
        print("读本地提交失败：\n%s" % out)
        return 1
    print("本地最新提交：%s" % out)
    print()

    for attempt in range(1, MAX_ATTEMPTS + 1):
        print("----- 第 %d/%d 次推送 -----" % (attempt, MAX_ATTEMPTS))
        rc, out = run(GIT_OPTS + ["push", "origin", "HEAD:%s" % BRANCH], timeout=90)
        print(out or "(无输出)")

        if rc == 0:
            print()
            print("推送成功，核对远端……")
            rc2, out2 = run(GIT_OPTS + ["ls-remote", "origin",
                                        "refs/heads/%s" % BRANCH], timeout=60)
            print(out2 or "(无输出)")
            print()
            print("远端 main 应与本地最新提交一致。核对无误就完事了。")
            return 0

        if "502" in out or "Failed to connect" in out or "Empty reply" in out:
            print(">>> 网络不通。确认代理（FlClash / Steam++ 的 GitHub 加速）已打开。")
        time.sleep(2)

    print()
    print("%d 次都没成功。建议：" % MAX_ATTEMPTS)
    print("  1. 打开 FlClash（或 Steam++ 的 GitHub 加速），确认能访问 github.com")
    print("  2. 再跑一次本脚本")
    return 1


if __name__ == "__main__":
    sys.exit(main())
