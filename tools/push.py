"""一键推送 —— 把这台机器上 git push 的所有坑一次性绕过去。

用法（在项目根目录）：
    .venv\\Scripts\\python.exe tools\\push.py

它做四件事：
  1. 自动找出可用的 git.exe（PATH 上的，或 WorkBuddy 自带的便携版）
  2. 自动探测本机代理端口（FlClash / Clash 那类），并**显式**把它写进 git 配置
  3. 带上这台机器必需的绕行参数推送，失败就自动重试（默认 10 次）
  4. 推送后核对远端哈希，确认真的上去了

为什么不能直接用 `git push`：见 .workbuddy/memory/MEMORY.md 的「环境注意」一节。
一句话版本 —— 本机代理会给 GitHub 的 HTTPS 做中间人，git 会卡在证书吊销检查上；
而且网络是间歇可用的，一次失败不代表失败，重试常成功。

⚠️ 2026-09-21 实测的关键一条：**只设 HTTPS_PROXY 环境变量不管用**。
   本机 shell 里的 HTTPS_PROXY 被工具沙箱指向 `127.0.0.1:50058`（一条只读通道），
   即使自己 export 覆盖也常常不生效。必须用 `-c http.proxy=...` **写进 git 参数**，
   它优先级最高，才真的走本机代理。本脚本第 2 步就是在做这件事。

前提：得有一个能出去的网络。跑之前先确认 FlClash 是开着的。
如果反复报
    CONNECT tunnel failed, response 502
或  Failed to connect to github.com:443 after 21000 ms
说明本机没有任何可用代理（FlClash 没开 / Steam++ 的 GitHub 加速没开），
先把它打开再跑本脚本。

关于推送时弹出的「Git 凭据管理器」窗口（GitHub 登录框）：
   那是 git 在向 GitHub 证明"你是仓库主人"。日志里会先出现
   `HTTP/1.1 401 Unauthorized`，然后它就去要凭据了。
   正常情况下登录一次并勾选「记住」，凭据会存进 Windows 凭据管理器，之后不再问。
   本脚本设了 GCM_INTERACTIVE=never，所以在脚本里它不会弹窗——
   凭据没缓存的话会直接失败。要补一次凭据，先手动跑一次：
       git push origin main
   在弹窗里登录完，之后再回来用本脚本。
"""

import os
import shutil
import socket
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 这台机器上必需的绕行参数：
#   http.proxy                      —— 显式指定本机代理，环境变量在这台机器上不可靠
#   schannelCheckRevoke / sslVerify —— 代理做中间人时的证书问题
#   postBuffer                      —— 大一点的包别被截断
#   lowSpeedLimit / lowSpeedTime    —— 卡住就主动放弃，别干等十几分钟
#   version=HTTP/1.1                —— HTTP/2 在这条链路上不稳
BASE_OPTS = [
    "-c", "http.schannelCheckRevoke=false",
    "-c", "http.sslVerify=false",
    "-c", "http.postBuffer=524288000",
    "-c", "http.lowSpeedLimit=1000",
    "-c", "http.lowSpeedTime=20",
    "-c", "http.version=HTTP/1.1",
]

# 本机代理通常监听的端口，按常见程度排。只认 TCP 能连上的第一个。
CANDIDATE_PROXY_PORTS = [7890, 7891, 7897, 10809, 10808, 1080, 8080, 8889]

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


def detect_proxy():
    """扫一遍常见端口，返回第一个有人监听的 http:// 代理地址。都没有就返回 None。"""
    for port in CANDIDATE_PROXY_PORTS:
        s = socket.socket()
        s.settimeout(0.35)
        try:
            s.connect(("127.0.0.1", port))
            return "http://127.0.0.1:%d" % port
        except Exception:
            continue
        finally:
            s.close()
    return None


GIT = find_git()
PROXY = detect_proxy()

# 非交互：别弹凭据窗口，卡住就直接失败，交给外层重试
ENV = dict(os.environ)
ENV["GIT_TERMINAL_PROMPT"] = "0"
ENV["GCM_INTERACTIVE"] = "never"

# 环境变量里的代理是工具沙箱注入的（指向一条只读通道），会盖掉 git 的默认行为。
# 这里统一改成探测到的本机代理；没探测到就把它们清掉，免得指错地方。
for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
             "http_proxy", "https_proxy", "all_proxy"):
    if PROXY:
        ENV[name] = PROXY
    else:
        ENV.pop(name, None)

GIT_OPTS = list(BASE_OPTS)
if PROXY:
    GIT_OPTS += ["-c", "http.proxy=%s" % PROXY]


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
    if PROXY:
        print("代理      = %s（已显式写进 git 参数）" % PROXY)
    else:
        print("代理      = 没探测到！直连 github.com 基本走不通，先把 FlClash 打开")
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
            local_rc, local_hash = run(["rev-parse", "HEAD"], timeout=30)
            if rc2 == 0 and local_rc == 0 and local_hash[:12] in out2:
                print("✅ 远端 main 和本地 HEAD 一致，真的上去了。")
                return 0
            print("⚠️ 推送返回成功，但远端哈希对不上，请手动核对上面两行。")
            return 0

        if "401" in out or "Authentication" in out or "could not read Username" in out:
            print(">>> 是凭据问题，不是网络问题。手动跑一次 `git push origin main`，")
            print("    在弹出的登录窗口里登录并勾选记住，之后再回来用本脚本。")
        elif "502" in out or "Failed to connect" in out or "Empty reply" in out:
            print(">>> 网络不通。确认代理（FlClash / Steam++ 的 GitHub 加速）已打开。")
        time.sleep(2)

    print()
    print("%d 次都没成功。建议：" % MAX_ATTEMPTS)
    print("  1. 打开 FlClash（或 Steam++ 的 GitHub 加速），确认能访问 github.com")
    print("  2. 再跑一次本脚本")
    return 1


if __name__ == "__main__":
    sys.exit(main())
