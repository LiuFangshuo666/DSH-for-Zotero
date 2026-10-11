/**
 * PowerShell 脚本的编码与部署安全性，以及 Gecko 路径拼接。
 *
 * # PowerShell：为什么单独守这一条（真机踩得很深）
 *
 * `tools/*.ps1` 在 **Windows PowerShell 5.1** 下运行，而 5.1 读取**没有 BOM** 的
 * UTF-8 文件时按 **ANSI（本地代码页）** 解释。于是文件里的中文注释会被解码成乱码 ——
 * 而乱码里可能出现反引号或双引号，**足以破坏脚本语法**。
 *
 * 症状极具误导性：`$PSScriptRoot` 变成空字符串，于是路径全错，
 * 而脚本**仍然打印 `deployed: …\.xpi (202980 bytes)` 并返回 0** ——
 * 一个叫 `.xpi` 的、没有 ID 的垃圾文件被当成部署成功。失败却报成功，
 * 是这个项目里最难查的一类故障。
 *
 * 修法有两条，本文件两条都守：
 *
 *  1. **带 BOM**（首选）—— 让 5.1 正确识别 UTF-8，中文注释可以保留；
 *  2. 与脚本自身位置相关的默认值**不要写在 `param` 块里** ——
 *     `param` 默认值在被调用那一刻求值，那时 `$PSScriptRoot` 尚未赋值。
 *
 * # Gecko 路径拼接
 *
 * `IOUtils` 对反斜杠与正斜杠混用的路径（`…\plugin/package.json`）会直接抛
 * `NS_ERROR_FILE_UNRECOGNIZED_PATH`。真机上"应用自定义 provider"因此**整段失败**，
 * 而日志里只有一句难以理解的 OperationError。
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const toolsDir = join(root, "tools");
const srcDir = join(root, "src");

/** tools/ 下所有 .ps1（脚本可能被删，所以动态枚举而不是写死清单） */
const scripts = readdirSync(toolsDir).filter((f) => f.endsWith(".ps1"));

/** 遍历目录下所有指定后缀的文件 */
function filesUnder(dir, ext, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) filesUnder(p, ext, out);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

describe("PowerShell 脚本的编码", function () {
  it("至少存在一个 .ps1（否则本文件失去意义）", function () {
    assert.ok(scripts.length > 0, "tools/ 下应当有部署脚本");
  });

  it("含非 ASCII 的脚本**必须带 UTF-8 BOM**（5.1 否则按 ANSI 解码）", function () {
    const offenders = [];
    for (const name of scripts) {
      const bytes = readFileSync(join(toolsDir, name));
      const hasBom =
        bytes.length >= 3 &&
        bytes[0] === 0xef &&
        bytes[1] === 0xbb &&
        bytes[2] === 0xbf;
      // 无 BOM 时只有"纯 ASCII"才安全；有非 ASCII 就必须有 BOM。
      //
      // 刻意不用 /[^\x00-\x7F]/：它含控制字符范围，会被 no-control-regex 拦下。
      const text = bytes.toString("utf8");
      const hasNonAscii = [...text].some((ch) => ch.codePointAt(0) > 0x7f);
      if (hasNonAscii && !hasBom) offenders.push(name);
    }
    assert.deepEqual(
      offenders,
      [],
      `这些脚本含非 ASCII 却没有 BOM，在 Windows PowerShell 5.1 下会被按 ANSI 解码，` +
        `中文注释将变成乱码并可能破坏语法（真机上曾因此把 xpi 部署成 '.xpi' 却报成功）：\n    ` +
        offenders.join("\n    ") +
        `\n  修法：以「UTF-8 带 BOM」重新保存。`,
    );
  });
});

describe("PowerShell 脚本的路径解析", function () {
  it("不在 param 块的默认值里用 $PSScriptRoot（那时它还是空的）", function () {
    const offenders = [];
    for (const name of scripts) {
      const text = readFileSync(join(toolsDir, name), "utf8");
      const open = text.indexOf("param(");
      if (open < 0) continue;
      // param 块从 `param(` 到脚本里第一个顶格的 `)`
      const close = text.indexOf("\n)", open);
      if (close < 0) continue;
      const paramBlock = text.slice(open, close);
      // 去掉注释行后再查，避免"解释为什么不能用"的注释被误判
      const code = paramBlock
        .split("\n")
        .filter((l) => !/^\s*#/.test(l))
        .join("\n");
      if (/\$PSScriptRoot/.test(code)) offenders.push(name);
    }
    assert.deepEqual(
      offenders,
      [],
      `param 块的默认值在被调用那一刻求值，而 $PSScriptRoot 那时还是空的 —— ` +
        `路径会被拼成一个缺了脚本目录的相对路径，进而让脚本静默失败：\n    ` +
        offenders.join("\n    ") +
        `\n  修法：默认值留空（""），到脚本体里再补。`,
    );
  });

  it("部署脚本会校验 addonID 非空（空的 ID 会部署成 '.xpi'）", function () {
    const text = readFileSync(join(toolsDir, "deploy-to-zotero.ps1"), "utf8");
    assert.match(
      text,
      /IsNullOrWhiteSpace\(\$addonId\)/,
      "必须有非空校验 —— 空 ID 会让脚本把文件部署成 '.xpi'，却仍打印 deployed 并返回 0",
    );
    assert.match(
      text,
      /IsNullOrWhiteSpace\(\$SourceXpi\)/,
      "构建产物路径也要在脚本体里补默认值（不能放在 param 块）",
    );
  });
});

describe("Gecko 路径拼接（模板串拼文件路径会整段失败）", function () {
  it("不用模板串拼**直接传给 IOUtils 的**路径（会得到反斜杠与正斜杠混用）", function () {
    // 真机故障：`${dir}/package.json` 得到 `…\profiles\plugin/package.json`，
    // 而 Gecko 的 IOUtils.exists 直接抛 NS_ERROR_FILE_UNRECOGNIZED_PATH ——
    // 整个"应用自定义 provider"全盘失败，日志里只有一条难以理解的 OperationError。
    // 正确写法是 PathUtils.join。
    //
    // ⚠️ 判据收窄到"模板串**直接**作为 IOUtils 调用的实参"：
    // 早先按"模板串里出现 /文件名"来判，把两类误报也抓了进来 ——
    //   · 写给 agent 的说明文字（`见 ${TOOL_DIR}/README.md`）—— 那是文本，不是路径；
    //   · 包了一层的辅助函数（`readOr(`${dir}/package.json`)`）—— 它最终交给
    //     IOUtils 的是**完整字符串**，在 Windows 上能被正确解析。
    // 误报会让这条测试被无视，比没有测试更糟。
    const offenders = [];
    for (const f of filesUnder(srcDir, ".ts")) {
      const text = readFileSync(f, "utf8");
      // 跨行匹配：IOUtils.exists(\n  `...`,\n)
      text.split("\n").forEach((line, i) => {
        if (
          !/IOUtils\.(exists|readUTF8|writeUTF8|makeDirectory)\s*\(/.test(line)
        )
          return;
        // 同一行里有模板串路径就算（多行调用时模板串在下一行，另行判断）
        if (/\$\{[^}]*\}\s*[/\\]\s*[A-Za-z0-9_.-]+/.test(line)) {
          offenders.push(
            `${f.replace(root, "").replace(/\\/g, "/")}:${i + 1}  ${line.trim()}`,
          );
        }
      });
    }
    assert.deepEqual(
      offenders,
      [],
      `这些地方用模板串拼路径并**直接**交给 IOUtils，Gecko 可能报 ` +
        `NS_ERROR_FILE_UNRECOGNIZED_PATH：\n    ` +
        offenders.join("\n    ") +
        `\n  改成 PathUtils.join(...)。`,
    );
  });

  it("模型一节里的文件路径都走 PathUtils.join", function () {
    // 这两处不是"直接传给 IOUtils"，但同样是真实的文件路径 ——
    // 统一用 PathUtils.join 才能保证跨平台正确。
    const panel = readFileSync(
      join(srcDir, "modules", "modelPanel.ts"),
      "utf8",
    );
    assert.ok(
      !/\$\{paths\.profile\}\//.test(panel),
      "profile 下的文件路径要拼 PathUtils.join，不要写 `${paths.profile}/…`",
    );
    assert.ok(
      !/\$\{config\.dshHome\}\//.test(panel),
      "凭据文件路径要拼 PathUtils.join，不要写 `${config.dshHome}/…`",
    );
  });
});
