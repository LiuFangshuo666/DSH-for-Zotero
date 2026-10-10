/**
 * 宿主启动代理脚本的**源码文本**。
 *
 * ## 为什么需要这一层（真机实测，不是设计偏好）
 *
 * 插件的进程由 Zotero 沙箱通过 `Subprocess.sys.mjs` 拉起，**stdout 管道读不到任何数据**：
 *
 *   等待启动 URL 已 85s：stdout 0 字节，stderr 1179 字节（stdout 仍为空）
 *
 * 而同一台机器、同样的参数，在 PowerShell 里 2 秒就抓到
 * `dsh web: http://127.0.0.1:19400/?token=…`（83 字节）。
 * **stderr 能读、stdout 读不到** —— 不是宿主不打印，是那条管道在沙箱里拿不到数据。
 *
 * 少了这个 token 就没办法登录网页界面（`Set-Cookie` 是 HttpOnly，
 * 且 `Services.cookies.add` 在本机 9 种参数形态全部失败），所以必须换一条通道。
 *
 * 这一层把宿主 stdout 接过来，把带 token 的 URL **写到文件**，插件读文件即可 ——
 * 文件 I/O 在本机是可靠的（运行时提取、凭据读写都靠它）。
 *
 * ## 为什么用「模板字符串」内嵌
 *
 * 脚本要由 Node 以**文件路径**执行，而插件内的资源是 `resource://` URI，不能直接交给 Node，
 * 所以必须内嵌成字符串再落盘。
 *
 * 这里刻意用反引号模板而不是普通引号：普通引号里的 `\n`、`\/`、`\.` 需要双层转义
 * （写 `\\n`），而落盘后要还原成 `\n` —— 这一还原我实测写错过一次
 * （生成的脚本里出现了真换行，`node --check` 直接报错）。
 * 模板字符串里除反引号和 `${` 之外都按字面处理，因此下面的脚本**几乎原样**，
 * 不需要任何还原步骤。
 */
export const HOST_LAUNCHER_FILE_NAME = "host-launcher.mjs";

export const HOST_LAUNCHER_SOURCE = `/**
 * dsh 宿主的启动代理（由 DSH-for-Zotero 自动生成，请勿手工编辑）。
 *
 * 职责：把宿主的 stdout 接过来，把带 token 的启动 URL 写到文件供插件读取
 * —— 因为在 Zotero 沙箱里读不到这条管道的输出。
 *
 * 用法：node host-launcher.mjs <urlFile> <hostEntry> [宿主参数…]
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [urlFile, hostEntry, ...hostArgs] = process.argv.slice(2);
if (!urlFile || !hostEntry) {
  process.stderr.write("host-launcher: usage node host-launcher.mjs <urlFile> <hostEntry> [args...]\\n");
  process.exit(2);
}

// 先清空：否则插件可能读到上一次运行的陈旧 URL
try {
  writeFileSync(urlFile, "");
} catch {
  // 写不了就继续，抓到 URL 时还会再写
}

const child = spawn(process.execPath, ["--expose-internals", hostEntry, ...hostArgs], {
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

const URL_PATTERN = /https?:\\/\\/127\\.0\\.0\\.1:\\d+\\/\\?token=[\\w-]+/;

function forward(stream, sink) {
  stream.on("data", (chunk) => {
    try {
      sink.write(chunk);
    } catch {
      // 父进程的管道可能已关闭
    }
    const match = URL_PATTERN.exec(String(chunk));
    if (match) {
      try {
        writeFileSync(urlFile, match[0]);
      } catch {
        // 尽力而为
      }
    }
  });
  stream.on("error", () => {});
}

forward(child.stdout, process.stdout);
forward(child.stderr, process.stderr);

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (error) => {
  process.stderr.write("host-launcher: failed to start host: " + error.message + "\\n");
  process.exit(1);
});

// 父进程（插件）结束时一并结束宿主，避免留下孤儿进程
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    try {
      child.kill();
    } catch {
      // 已退出
    }
    process.exit(0);
  });
}
process.on("exit", () => {
  try {
    child.kill();
  } catch {
    // 已退出
  }
});
`;
