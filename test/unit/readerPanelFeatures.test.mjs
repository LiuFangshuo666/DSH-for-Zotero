/**
 * ## 伴读侧栏的四项改进：行为守卫
 *
 * 1. 助手回答按 **Markdown 渲染**；
 * 2. 会话下拉用**人能读的名字**；
 * 3. 历史会话**可删除**；
 * 4. 图标换成蓝色鲸鱼（在 mainToolbar 的用例里覆盖）。
 *
 * 这组守卫的重点是**安全**与**诚实**，不是"功能存在"：
 *
 * - Markdown 渲染必然要碰 `innerHTML`，而这里原本的纪律是"绝不 innerHTML"
 *   （论文与模型输出都可能含标记）。破例的唯一理由是这个转换器
 *   **先整体 escapeHtml**、只生成白名单标签。所以守卫必须钉住：
 *   `innerHTML` 的右值里**必须**出现 `markdownToHtml`。一旦有人图省事写成
 *   `innerHTML = cell.text`，那就是**注入漏洞**，不是样式问题。
 *
 * - 删除会话必须**如实说明它删不掉宿主数据** —— dsh 没有删除会话的接口
 *   （`session/delete` 等逐个试过全是 404）。若文案让用户以为磁盘被清空，
 *   那是在骗人。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codeOnly } from "./helpers/codeOnly.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const code = codeOnly(
  readFileSync(join(root, "src", "modules", "readerPanel.ts"), "utf8"),
);

describe("伴读侧栏", function () {
  it("助手回答用 markdownToHtml 渲染", function () {
    assert.match(
      code,
      /markdownToHtml\(cell\.text\)/,
      "助手气泡必须经过 markdownToHtml",
    );
  });

  it("**每一处 innerHTML 都必须经过 markdownToHtml**", function () {
    // 这条是安全底线：markdownToHtml 先 escapeHtml 再生成白名单标签。
    // 直接 `innerHTML = cell.text` 会让模型输出（或论文原文）里的
    // `<script>`、`<img onerror>` 变成真正的标签 —— 那是注入漏洞。
    const assignments = code.match(/innerHTML\s*=[\s\S]*?;/g) ?? [];
    assert.ok(assignments.length > 0, "应当有渲染助手回答的 innerHTML 赋值");
    for (const statement of assignments) {
      assert.match(
        statement,
        /markdownToHtml\(/,
        `这处 innerHTML 没有经过 markdownToHtml：${statement.slice(0, 80)}`,
      );
    }
    assert.ok(
      !/innerHTML\s*=\s*cell\.text/.test(code),
      "绝不能把模型原文直接塞进 innerHTML",
    );
  });

  it("Markdown 样式只注入一次（重复渲染不会越堆越多）", function () {
    assert.match(
      code,
      /getElementById\(id\)\) return/,
      "注入样式前必须按 id 判重 —— paintMessages 每次渲染都会调用它",
    );
    assert.match(code, /classList\.add\("dsh-md"\)/, "助手气泡要带 dsh-md 类");
  });

  it("会话下拉用 sessionOptionLabel，而不是原始 sessionId", function () {
    assert.match(
      code,
      /sessionOptionLabel\(/,
      "选项文字必须走 sessionOptionLabel",
    );
    assert.ok(
      !/sessionId\.slice\(0, 12\)/.test(code),
      "不应再把 session-xxxx… 这种机器 id 直接显示给用户",
    );
  });

  it("已删除的会话会被过滤掉", function () {
    assert.match(code, /deletedSessionIds\(\)/, "必须读取已删除集合");
    assert.match(code, /hidden\.has\(/, "必须按它过滤下拉选项");
  });

  it("删除会话：要确认、要删记录、要写隐藏表", function () {
    assert.match(code, /confirmDialog\(/, "删除前必须弹确认");
    assert.match(code, /recordStore\(\)\.remove\(/, "必须删掉插件会话记录");
    assert.match(code, /markSessionDeleted\(/, "必须写进已删除表");
  });

  it("删除文案必须**如实说明宿主数据仍保留**", function () {
    // dsh 没有删除会话的接口（session/delete 等全部 404）。
    // 若文案暗示"磁盘也清空了"，就是在骗用户。
    assert.match(
      code,
      /没有删除会话的接口/,
      "必须告诉用户：dsh 侧没有删除接口，宿主磁盘上的数据仍在",
    );
    assert.match(code, /仍会保留|仍在/, "必须明确数据仍保留");
  });
});
