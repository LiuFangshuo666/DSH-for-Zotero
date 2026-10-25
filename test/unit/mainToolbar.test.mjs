/**
 * ## 主窗口工具栏的下拉：两个真实会翻车的点
 *
 * ### ① 按钮"存在但看不见"
 *
 * Zotero 的 `.zotero-tb-button` 图标是**按 id 逐条配 CSS** 的：
 *
 * ```css
 *   #zotero-tb-add { list-style-image: url("chrome://zotero/skin/…") }
 * ```
 *
 * 自建的 id 不匹配任何规则 → 按钮在 DOM 里、但**没有图标也看不见**。
 * 这种"加了等于没加"最难排查，所以必须显式设置 `list-style-image`。
 *
 * ### ② 升级后变成两个按钮
 *
 * 按钮是我们**自己插进去的 DOM**，Zotero 不会替我们清理。
 * 若停用/升级时不收走，重新加载就会再插一个 —— 用户看到两个一模一样的图标。
 *
 * ### ③ 挂载点的 id 必须来自实测
 *
 * 用 Zotero 10.0.6 自带 `chrome/content/zotero/zoteroPane.xhtml` 核对过：
 * `#zotero-items-toolbar` 是条目列表工具条（内含 `zotero-tb-add`、`zotero-tb-lookup`）。
 * 猜 id 的后果是"按钮不出现"且没有任何报错。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codeOnly } from "./helpers/codeOnly.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const src = readFileSync(
  join(root, "src", "modules", "mainToolbar.ts"),
  "utf8",
);
/**
 * 剥掉注释后的源码。
 *
 * ⚠️ 所有"代码里有没有 X"的判断都必须用它：直接扫原文会把**说明文字**当成
 * 违规或当成已实现（假红 / 假绿都出现过）。
 *
 * 用共享助手而不是本地实现：剥离顺序有讲究 —— **先剥行注释再剥块注释**。
 * 本文件的注释里就有 `universal` + 斜杠 + 星号 + `.svg` 这种序列，
 * 顺序反了会让块注释正则从那里开始，一路吃到下一个闭合序列，
 * **删掉两千多字符的真实代码**。
 */
const code = codeOnly(src);
const hooks = readFileSync(join(root, "src", "hooks.ts"), "utf8");

describe("主窗口工具栏下拉", function () {
  it("挂载点用的是实测过的 Zotero 真实 id", function () {
    // 这些 id 来自 zoteroPane.xhtml，不是记忆
    for (const id of ["zotero-items-toolbar", "zotero-collections-toolbar"]) {
      assert.ok(
        src.includes(id),
        `必须包含实测过的挂载点 ${id}（找不到时应按候选顺序退让）`,
      );
    }
    assert.match(
      src,
      /TOOLBAR_CANDIDATES/,
      "必须有候选顺序，而不是只认一个 id —— 换 Zotero 版本时才能退让",
    );
  });

  it("**必须显式设置图标**（否则按钮在 DOM 里但看不见）", function () {
    // ⚠️ 必须用剥注释后的 code：模块注释里写着 `list-style-image` 这个词，
    // 用原文判断会永远通过 —— 这条守卫第一次写出来就是"永远绿"的假守卫，
    // 是"破坏代码看它是否变红"的验证把它抓出来的。
    assert.match(
      code,
      /list-style-image/,
      "Zotero 按 id 配图标，自建 id 不设 list-style-image 会得到一个看不见的按钮",
    );
    assert.match(
      code,
      /chrome:\/\/\$\{addonRef\}\/content\//,
      "图标要用插件自己的 chrome:// 资源",
    );
  });

  it("**装不上时必须留下日志**（否则只是「按钮没出现」）", function () {
    assert.match(
      src,
      /找不到挂载点/,
      "找不到挂载点要记日志并列出试过的 id，否则无从判断",
    );
  });

  it("插件关闭时必须**收走按钮**（否则升级后变两个）", function () {
    assert.match(
      hooks,
      /uninstallMainToolbar\(\)/,
      "onShutdown 里必须调用 uninstallMainToolbar —— 自插的 DOM 要自己清理",
    );
  });

  it("挂载是幂等的（已存在就不重复插）", function () {
    assert.match(
      src,
      /getElementById\(BUTTON_ID\)\) return true/,
      "重复调用不能插出第二个按钮",
    );
  });

  it("按钮 id 带插件前缀，避免和 Zotero 或别的插件撞名", function () {
    assert.match(src, /dsh-for-zotero-toolbar-menu/);
  });

  it('**必须有 wantdropmarker="true"**（否则没有那个向下的小箭头）', function () {
    // 真机反馈："图标右边加个向下的小箭头，仿照官方图标样式"。
    // Zotero 主工具栏里 3 个 type="menu" 的按钮
    // （zotero-tb-add / toolbar-add-attachment / zotero-tb-note-add）
    // **全部**带这个属性 —— 少了它按钮能下拉，但看不出有菜单。
    assert.match(
      code,
      /wantdropmarker"\s*,\s*"true"/,
      "type=menu 的 toolbar 按钮必须设 wantdropmarker=true，否则没有下拉箭头",
    );
  });

  it("下拉里有两种新建会话，且排在其它动作之前", function () {
    // 用户要求："把两种新建会话也放到这个按钮里"。
    // 它们是这个按钮的主要用途，所以排最前；网页版/工作区属于次要动作。
    const itemAt = code.indexOf("新建文献会话");
    const collectionAt = code.indexOf("新建独立会话");
    const webAt = code.indexOf("在网页版打开 dsh");
    assert.ok(itemAt > 0, "下拉里必须有「新建文献会话」");
    assert.ok(collectionAt > 0, "下拉里必须有「新建独立会话」");
    assert.ok(webAt > 0, "「在网页版打开」应保留");
    assert.ok(
      itemAt < webAt && collectionAt < webAt,
      "两种新建会话必须排在「在网页版打开」之前（那是这个按钮的主要用途）",
    );
    // 必须通过注入的动作调用，不能在这里重写一套建会话逻辑
    assert.match(
      code,
      /actions\.newItemSession\(\)/,
      "应调用注入的 newItemSession",
    );
    assert.match(
      code,
      /actions\.newCollectionSession\(\)/,
      "应调用注入的 newCollectionSession",
    );
  });

  it("建会话失败必须说原因（工具栏上用户不会去翻日志）", function () {
    // 右键菜单那套只往日志写一行；工具栏上没人会去看日志，
    // 所以失败要抛错并进进度窗口。
    assert.match(
      code,
      /describe\(error\)/,
      "失败路径必须把原因转成一句话交给进度窗口",
    );
  });

  it("没选中对象时把两个建会话项**置灰**，且每次弹出都重算", function () {
    // 与 Zotero 自带的「新建条目 / 添加附件 / 新建笔记」一致：
    // 没选中条目时那些是灰的。
    assert.match(
      code,
      /actions\.canCreate\("item"\)/,
      "必须用 canCreate(item) 判断条目会话项是否可点",
    );
    assert.match(
      code,
      /actions\.canCreate\("collection"\)/,
      "必须用 canCreate(collection) 判断独立会话项是否可点",
    );
    // ⚠️ 时机：必须在 popupshowing 时重算。挂载时只算一次的话，
    // 启动时通常什么都没选中 —— 那两项会**永远灰着**。
    assert.match(
      code,
      /addEventListener\("popupshowing"/,
      "启用状态必须在每次弹出菜单时重算（popupshowing），不能在挂载时算一次",
    );
    assert.match(
      code,
      /setAttribute\("disabled",\s*"true"\)/,
      "禁用要用 disabled 属性（XUL 的置灰方式）",
    );
    assert.match(
      code,
      /removeAttribute\("disabled"\)/,
      "可用时必须把 disabled 去掉，否则一旦灰过就再也点不了",
    );
  });

  it("**按钮本身不禁用**（网页版/工作区与选中状态无关）", function () {
    // 只灰掉两个建会话项。若把整个按钮禁掉，没选中文献时
    // 连"在网页版打开"都用不了 —— 那两个动作不需要选中任何东西。
    assert.ok(
      !/button\.setAttribute\("disabled"/.test(code),
      "不得禁用整个按钮：只在菜单项级别置灰",
    );
  });

  it("动作结果用 Zotero 进度窗口告知，不用阻塞式 alert", function () {
    assert.match(code, /ProgressWindow/);
    assert.ok(
      !/\balert\s*\(/.test(code),
      "不要用 alert（会打断用户），用 Zotero 的 ProgressWindow",
    );
  });

  it("工具栏图标用专用 SVG，不是带白底的 favicon，也不是 PNG", function () {
    // 1. 不能是 favicon：它是"圆角白卡片 + 近黑鲸鱼"，放工具条上白底突兀、太黑、偏大。
    // 2. 不能是 PNG：XUL 的 list-style-image 按图片**内在尺寸**绘制，
    //    `max-width` 只约束元素盒子、不缩放标记图。给 PNG 就会按画布像素画
    //    （用户反馈"鲸鱼更大了"就是这么来的）。
    // 3. 必须是**外在尺寸固定**的 SVG —— Zotero 自己的工具条图标同样是 16×16 SVG。
    assert.match(
      code,
      /content\/icons\/toolbar-dsh\.svg/,
      "必须用 toolbar-dsh.svg（外在尺寸固定 16×16，内部嵌高分辨率位图）",
    );
    assert.ok(
      !/content\/icons\/favicon/.test(code),
      "不要直接用 favicon —— 它自带圆角白底，在工具条上很突兀",
    );
    assert.ok(
      !/content\/icons\/toolbar-dsh\.png/.test(code),
      "不要用 PNG —— list-style-image 会按它的像素尺寸绘制，无法靠 max-width 收小",
    );
  });

  it("图标 SVG 必须自己声明固定的外在尺寸", function () {
    // 这条是"鲸鱼变大了"那次事故的正面守卫：
    // 尺寸必须由**资源本身**决定，不能指望元素的 max-width。
    //
    // ⚠️ 守的是**性质**，不是某个具体像素值 —— 尺寸可以按用户偏好调整
    // （16 → 20 → 22 → 23 都改过），把数字写死会让"改尺寸"变成"改测试"。
    //
    // ⚠️ 外在尺寸与 viewBox **不必相等**：viewBox 是内部坐标系（现在用 96
    // 画布的位图），width/height 是显示尺寸。两者相等只是巧合下的特例。
    const svg = readFileSync(
      join(root, "addon", "content", "icons", "toolbar-dsh.svg"),
      "utf8",
    );
    const width = /<svg[^>]*\bwidth="(\d+)"/.exec(svg);
    const height = /<svg[^>]*\bheight="(\d+)"/.exec(svg);
    const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
    assert.ok(width, "SVG 必须显式声明数字 width（否则按位图像素尺寸绘制）");
    assert.ok(height, "SVG 必须显式声明数字 height");
    assert.ok(viewBox, "SVG 必须有 viewBox");
    assert.equal(width[1], height[1], "图标必须是正方形（宽高一致）");
    assert.equal(viewBox[1], viewBox[2], "viewBox 必须是正方形");
    const size = Number(width[1]);
    assert.ok(
      size >= 12 && size <= 28,
      `外在尺寸 ${size}px 超出合理区间 12–28：` +
        "太小看不清，太大在 41px 高的工具条上会压过 Zotero 自带的图标",
    );
    // 内嵌位图必须是高分辨率的，否则 HiDPI 下糊
    assert.ok(
      svg.length > 4000,
      `SVG 只有 ${svg.length} 字节，内嵌位图可能分辨率不足（HiDPI 会糊）`,
    );
  });

  it("图标颜色必须跟随主题（蒙版 + context-fill），且**不靠描边**", function () {
    // 真机反馈：深灰本体 + 白描边在**深色主题**下糊成一团 —— 白描边变成主体，
    // 深灰本体融进背景。
    //
    // 解法不是换颜色（换哪种都会有一边不行），而是让颜色**跟随工具条前景色**：
    // 位图只当亮度蒙版，图形用 `fill="context-fill"` 上色。
    // Zotero 自己的图标就是这么做的。
    const svg = readFileSync(
      join(root, "addon", "content", "icons", "toolbar-dsh.svg"),
      "utf8",
    );
    assert.match(
      svg,
      /fill="context-fill"/,
      "图形必须用 context-fill 上色 —— 否则颜色被写死，总有一种主题下看不清",
    );
    assert.match(
      svg,
      /<mask[\s>]/,
      "必须是蒙版形式：位图只决定形状，颜色交给 context-fill",
    );
    // 按钮侧必须声明上下文属性，否则 context-fill 取不到值（会渲染成黑色）
    assert.match(
      code,
      /-moz-context-properties:\s*fill/,
      "按钮必须声明 -moz-context-properties: fill，否则 context-fill 取不到上下文",
    );
    assert.match(
      code,
      /fill:\s*currentColor/,
      "必须 fill: currentColor —— 让图标跟随工具条的前景色",
    );
  });
});
