/**
 * ## asar 外置条目（`unpacked: true`）必须被收集
 *
 * 真机事故（2026-10-17，用户报"应用失败：Cannot find package 'koffi'"）：
 *
 * asar 可以把文件**外置**到 `app.asar.unpacked/`（原生模块或体积大时）。
 * 这类条目在头部里**只有 `size`、没有 `offset`**：
 *
 * ```json
 *   {"size":206,"unpacked":true}
 * ```
 *
 * 我原来的判据是 `offset !== undefined`，于是 0.2.1-rc.2 的 **1583 个外置文件
 * 全部被跳过，而且没有任何报错** —— 提取照常报告"成功"。
 *
 * 后果不止 `koffi`：`@swc/helpers`（438 个）、`libreoffice-kit-win32-x64`（735 个）、
 * `fontkit`（127 个）等同样缺失，只是最先炸的是会话持久化那条路。
 *
 * 关键教训：**"提取成功"这件事本身没有自证能力** —— 少收集了文件，
 * 日志依然全绿。所以判据必须把"有没有 offset"与"该不该提取"分开。
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
const { collectAsarTargets } = bundle;

/** 构造头部树：files 是 路径段 → 节点 */
function tree(spec) {
  const root = { files: {} };
  for (const [path, node] of Object.entries(spec)) {
    const parts = path.split("/").filter(Boolean);
    let at = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      at.files[parts[i]] ??= { files: {} };
      at = at.files[parts[i]];
    }
    at.files[parts[parts.length - 1]] = node;
  }
  return root;
}

describe("asar 条目收集（含外置条目）", function () {
  it("普通条目：有 offset → unpacked=false，offset 转成数字", function () {
    const out = collectAsarTargets(
      tree({ "/dsh/a.js": { size: 10, offset: "44669811" } }),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].unpacked, false);
    assert.equal(out[0].offset, 44669811);
    assert.equal(
      typeof out[0].offset,
      "number",
      "offset 必须是数字 —— 字符串会变成拼接、切出空文件",
    );
    assert.equal(out[0].size, 10);
  });

  it("**外置条目：只有 size、没有 offset，必须仍被收集**", function () {
    // 这正是 koffi 的真实形状
    const out = collectAsarTargets(
      tree({
        "/dsh/node_modules/koffi/index.js": { size: 206, unpacked: true },
      }),
    );
    assert.equal(out.length, 1, "外置条目不能被跳过 —— 跳过就是整个包缺失");
    assert.equal(
      out[0].unpacked,
      true,
      "必须标成外置，供调用方去 unpacked 目录复制",
    );
    assert.equal(out[0].size, 206);
    assert.equal(out[0].path, "/dsh/node_modules/koffi/index.js");
  });

  it("`unpacked: true` 即使带了 offset 也算外置（以标记为准）", function () {
    const out = collectAsarTargets(
      tree({ "/dsh/x.node": { size: 5, offset: 100, unpacked: true } }),
    );
    assert.equal(out[0].unpacked, true);
  });

  it("没有 size 的条目（目录）不收集", function () {
    const out = collectAsarTargets(tree({ "/dsh/dir": { files: {} } }));
    assert.equal(out.length, 0);
  });

  it("只收集指定前缀下的文件（asar 里还有 /其它/ 的东西）", function () {
    const out = collectAsarTargets(
      tree({
        "/dsh/keep.js": { size: 1, offset: 0 },
        "/other/skip.js": { size: 1, offset: 0 },
      }),
    );
    assert.deepEqual(
      out.map((t) => t.path),
      ["/dsh/keep.js"],
    );
  });

  it("混合树里两类条目都要出现（防止修外置时弄丢普通条目）", function () {
    const out = collectAsarTargets(
      tree({
        "/dsh/node_modules/koffi/index.js": { size: 206, unpacked: true },
        "/dsh/node_modules/koffi/package.json": { size: 644, unpacked: true },
        "/dsh/node_modules/koffi/koffi.node": { size: 100, offset: "0" },
      }),
    );
    assert.equal(out.length, 3);
    assert.equal(out.filter((t) => t.unpacked).length, 2);
    assert.equal(out.filter((t) => !t.unpacked).length, 1);
  });
});
