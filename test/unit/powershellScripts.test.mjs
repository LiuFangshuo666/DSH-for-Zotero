/**
 * PowerShell 脚本的编码与部署安全性。
 *
 * # 为什么单独守这一条（真机踩得很深）
 *
 * `tools/*.ps1` 在 **Windows PowerShell 5.1** 下运行，而 5.1 读取**没有 BOM** 的
 * UTF-8 文件时按 **ANSI（本地代码页）** 解释。于是文件里的中文注释会被解码成乱码 ——
 * 而乱码里可能出现 `` ` ``（反引号）或 `"`，**足以破坏脚本语法**。
 *
 * 症状极具误导性：`$PSScriptRoot` 变成空字符串，于是
 *
 * ```text
 *   $packagePath = Join-Path $PSScriptRoot "..\package.json"   → 空
 *   $addonId     = (… 读一个空路径 …)                            → 空
 *   $target      = Join-Path $extDir ".xpi"                      → 扩展目录下多一个 ".xpi"
 * ```
 *
 * 而脚本**仍然打印 `deployed: …\.xpi (202980 bytes)` 并返回 0** ——
 * 一个叫 `.xpi` 的、没有 ID 的垃圾文件被当成部署成功。失败却报成功，
 * 是这个项目里最难查的一类故障。
 *
 * 修法有两条，本文件两条都守：
 *
 *  1. **带 BOM**（首选）—— 让 5.1 正确识别 UTF-8，中文注释可以保留；
 *  2. 与脚本自身位置相关的默认值**不要写在 `param` 块里** ——
 *     `param` 默认值在被调用那一刻求值，那时 `$PSScriptRoot` 尚未赋值。
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const toolsDir = join(root, "tools");

/** tools/ 下所有 .ps1（脚本可能被删，所以动态枚举而不是写死清单） */
const scripts = readdirSync(toolsDir).filter((f) => f.endsWith(".ps1"));

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
      // ⚠️ 这里刻意**不用** `/[^\x00-\x7F]/` 那种写法：它含控制字符范围，
      // 会被 `no-control-regex` 规则拦下。逐字符比较码点更直白、也不触发规则。
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
      // param 块从 `param(` 到与之配对的 `)` —— 脚本里它就是第一个顶格的 `)` 行
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
