/**
 * ## 宿主端口打补丁：判据必须容忍**版本演进**
 *
 * 真机事故（2026-10-17）：用户升级桌面端 DSH 后，**插件侧完全无法运行**，
 * 日志只有一句：
 *
 * ```text
 *   准备结果：error —— 准备失败：宿主里找不到预期的端口字面量
 *   （Harness 版本可能已变化）。为避免误改，已中止
 * ```
 *
 * 根因：插件靠替换宿主源码里的端口字面量来让端口可配置。旧版宿主写
 *
 * ```js
 *   "--port", "19387"
 * ```
 *
 * 新版改成了
 *
 * ```js
 *   "--port", "0"      // 0 = 让系统分配
 * ```
 *
 * 而我原来的正则把 `"19387"` **写死**在里面 —— 于是 DSH 一升级，插件就死。
 *
 * ## 教训
 *
 * 「找不到就中止」这个**决定是对的**（不改比改错好）——
 * 错的是**判据太窄**：它把"版本演进了"误判成"这个文件不认识"。
 * 现在的判据是「`--port` 后跟任意数字字面量」——那个**形状**比具体数字稳定得多。
 *
 * 这些用例就是把那个形状钉住：旧版要能过，新版要能过，**别的参数不能误伤**。
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await import(
  new URL(
    `file://${join(here, ".build", "unit-entry.mjs").replace(/\\/g, "/")}`,
  ).href
);
const { patchHostPortInSource } = bundle;

const ENV = "DSH_FOR_ZOTERO_PORT";

/** 旧版宿主的真实形状（制表符缩进） */
const OLD_FORM = [
  "args: [",
  '\t"--no-open",',
  '\t"--host",',
  '\t"127.0.0.1",',
  '\t"--port",',
  '\t"19387"',
  "],",
].join("\n");

/** 新版宿主的真实形状（`--port` 后是 "0"） */
const NEW_FORM = [
  "args: [",
  '\t"--no-open",',
  '\t"--host",',
  '\t"127.0.0.1",',
  '\t"--port",',
  '\t"0"',
  "],",
].join("\n");

describe("宿主端口打补丁（DSH 升级后插件起不来的根因）", function () {
  it('旧版的 "19387" 必须仍能打上（不能修新版坏旧版）', function () {
    const out = patchHostPortInSource(OLD_FORM, ENV);
    assert.equal(out.kind, "patched");
    assert.equal(out.hostDefault, "19387", "必须捕获原默认值");
    assert.ok(
      out.source.includes(`String(process.env.${ENV} ?? "19387")`),
      "替换后应读环境变量，兜底仍用宿主原默认",
    );
  });

  it('**新版的 "0" 必须能打上**（这正是本次事故）', function () {
    const out = patchHostPortInSource(NEW_FORM, ENV);
    assert.equal(
      out.kind,
      "patched",
      '新版 --port 后是 "0" —— 旧正则把 19387 写死，于是这里返回 not-found，插件起不来',
    );
    assert.equal(out.hostDefault, "0");
    assert.ok(
      out.source.includes(`String(process.env.${ENV} ?? "0")`),
      "兜底必须是宿主**原值** —— 否则会把新版的「自动分配」悄悄改成固定端口",
    );
  });

  it("未来出现别的数字默认值也应能打上（不再写死具体数字）", function () {
    for (const value of ["8080", "19400", "7"]) {
      const src = `args: ["--port", "${value}"],`;
      const out = patchHostPortInSource(src, ENV);
      assert.equal(out.kind, "patched", `端口默认值 ${value} 应能识别`);
      assert.equal(out.hostDefault, value);
    }
  });

  it("已打过时返回 already（幂等，不重复改）", function () {
    const out = patchHostPortInSource(NEW_FORM, ENV);
    assert.equal(out.kind, "patched");
    const again = patchHostPortInSource(out.source, ENV);
    assert.equal(
      again.kind,
      "already",
      "第二次必须识别为已打过，否则会套娃替换",
    );
  });

  it("**没有 --port 时必须 not-found**（不改比改错好）", function () {
    const src = 'args: ["--no-open", "--host", "127.0.0.1"],';
    assert.equal(patchHostPortInSource(src, ENV).kind, "not-found");
  });

  it("不得误伤别的数字参数", function () {
    // 只有紧跟 `"--port",` 的那个数字才是端口
    const src = [
      "args: [",
      '\t"--port",',
      '\t"0"',
      "],",
      "other: [",
      '\t"--timeout",',
      '\t"30"',
      "],",
    ].join("\n");
    const out = patchHostPortInSource(src, ENV);
    assert.equal(out.kind, "patched");
    assert.equal(
      out.hostDefault,
      "0",
      "必须命中 --port 的那个，而不是 --timeout 的",
    );
    assert.ok(
      out.source.includes('"--timeout",\n\t"30"'),
      "`--timeout` 的参数必须原样保留",
    );
  });
});
