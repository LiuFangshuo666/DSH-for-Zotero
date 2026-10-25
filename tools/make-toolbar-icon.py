"""生成主窗口工具栏用的「鲸鱼」图标。

原图 `addon/content/icons/favicon.png` 是**圆角白卡片 + 近黑鲸鱼**，直接放到
Zotero 主窗口工具条上有四个问题（用户反馈）：

1. 白卡片底在工具条上很突兀 → **去掉底色，只留鲸鱼**；
2. 近黑（#2E333B）太抢 → **改成深灰**；
3. 鲸鱼占满画布，显得大 → **缩小并留白**；
4. 深色模式下深灰贴着深色工具条会糊 → **描一圈白边**隔开。

做法：用亮度当 alpha 抠出鲸鱼轮廓（卡片接近纯白 → alpha 0），
再把轮廓按比例缩小、向外膨胀出一圈白边，最后贴到透明画布中央。

## 两个实测得出的参数结论（别凭直觉改）

1. **必须先把原图合成到白底再算亮度。**
   `Image.convert("L")` **完全忽略 alpha**：卡片外缘与透明背景之间的抗锯齿像素
   RGB 是深色、alpha 很低，直接算亮度会把**整张圆角卡片**抠进轮廓，
   输出仍然是个白方块。第一次生成就踩到了。

2. **不要把眼睛/肚皮的孔填成实心。**
   原作的鲸鱼本来就有一块**白肚皮**和白眼仁。填成实心剪影后，
   16px 下只剩一团灰疙瘩、认不出是鲸鱼；保留孔洞反而更像原图。
   （对照过 6 种"缩放比例 × 白边宽度 × 是否填孔"的组合，
   最终选 72 / 3 / 保留孔洞。）

生成的图标是可以复现的：改完参数重跑这个脚本即可。
"""

from PIL import Image

SRC = "addon/content/icons/favicon.png"
# 输出**SVG**，而不是 PNG。
#
# 为什么不是 PNG：XUL 的 `list-style-image` 按图片的**内在尺寸**绘制，
# `max-width` / `max-height` 只约束元素盒子、**不缩放标记图**。
# 先前给了一张 96×96 的 PNG，工具条就按 96px 画（被 41px 高的工具条裁），
# 用户反馈"鲸鱼更大了"。而 Zotero 自己的工具条图标是
# `chrome://zotero/skin/16/universal/*.svg` —— **16×16 的 SVG**。
# 所以这里也用 SVG：内部嵌高分辨率位图，外在尺寸钉死在 16×16，
# 任何 DPI 下都清晰，且尺寸可预测。
OUT = "addon/content/icons/toolbar-dsh.svg"
# 中间产物：高分辨率位图（只用于生成 SVG，不随插件发布）
RASTER = "tools/_icon-96.png"
# 工具条图标的**外在尺寸**（由 SVG 自己声明，不靠 CSS 缩放）。
#
# 16 = Zotero 自带图标的尺寸；20 → 22 → 23 → 24 是用户逐次实测后定的。
# 上限提醒：工具条高 41px，26 以上就会压过 Zotero 自己的按钮、显得不平衡。
# 想再调就改这一个数字，重跑本脚本即可。
SVG_SIZE = 24

CANVAS = 96  # 内嵌位图的分辨率（viewBox 与它一致）
INNER = 72  # 鲸鱼缩放后的最长边（约画布的 3/4，四周留白）

# ## 配色：**固定蓝色**（不再跟随主题）
#
# 用户在侧栏里要求"蓝色鲸鱼"，并明确工具栏也一起改。
#
# 为什么不能继续用 `context-fill` 跟随主题：这张图现在有**三个**使用方 ——
# 主工具栏按钮、条目面板的 `header.icon`、`sidenav.icon`。
# 后两个由 Zotero 以**图片**形式渲染，**不会**设置
# `-moz-context-properties`；`context-fill` 在那里取不到上下文，
# 图标会变成黑色甚至看不见。
#
# 所以颜色必须**写进图里**。蓝色取 medium blue：
# 在浅色工具条（#f6f6f6）与深色工具条（#2b2b2b）上都有足够对比度。
SHAPE_COLOR = (59, 130, 246)  # #3B82F6（blue-500）


def build_alpha(src: Image.Image) -> Image.Image:
    """按亮度做 alpha：鲸鱼接近 1，白卡片接近 0，边缘保留抗锯齿。

    ⚠️ **必须先合成到白底**再算亮度。
    `Image.convert("L")` **完全忽略 alpha** —— 原图卡片外缘与透明背景之间的
    抗锯齿像素，RGB 是"深色 + 低 alpha"（看起来像深灰），
    直接算亮度会把**整张卡片的轮廓**当成鲸鱼抠进 alpha，
    于是输出仍然是一个圆角白方块。这个坑第一次生成时就踩到了。
    """
    flat = Image.alpha_composite(
        Image.new("RGBA", src.size, (255, 255, 255, 255)), src
    )
    lum = flat.convert("L")
    # 鲸鱼实测 ~50 亮度，卡片 ~240。留出过渡带做抗锯齿。
    return lum.point(
        lambda v: 255 if v <= 90 else 0 if v >= 170 else int((170 - v) * 255 / 80)
    )


def main() -> None:
    src = Image.open(SRC).convert("RGBA")
    alpha = build_alpha(src)

    # 只留鲸鱼本体（底部卡片/阴影全被 alpha 判掉）
    shape = Image.new("RGBA", src.size, (255, 255, 255, 0))
    shape.putalpha(alpha)

    # 裁到鲸鱼实际范围，再等比缩小
    bbox = alpha.getbbox()
    if not bbox:
        raise SystemExit("抠不出鲸鱼轮廓：alpha 全空，阈值需要调整")
    print(f"  裁切框 {bbox}（应明显小于 {src.size[0]}x{src.size[1]}，否则说明卡片被抠进来了）")
    if (bbox[2] - bbox[0]) > src.size[0] * 0.92:
        raise SystemExit("裁切框几乎等于整幅图：卡片轮廓混进 alpha 了，检查 build_alpha")
    shape = shape.crop(bbox)

    scale = INNER / max(shape.size)
    inner = (max(1, round(shape.width * scale)), max(1, round(shape.height * scale)))
    shape = shape.resize(inner, Image.LANCZOS)

    # 贴到透明画布中央，得到**纯剪影**（没有描边）
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.alpha_composite(
        shape, ((CANVAS - shape.width) // 2, (CANVAS - shape.height) // 2)
    )

    # 把鲸鱼**染成固定蓝色**（不是蒙版）
    #
    # 早先这里用的是"位图当亮度蒙版 + `fill="context-fill"`"，让颜色跟随主题。
    # 那个方案对**主工具栏按钮**有效（Zotero 自己就是这么给图标配色的），
    # 但同一张图还要给条目面板的 `header.icon` / `sidenav.icon` 用 ——
    # 那里由 Zotero 当普通图片渲染，**不设置** `-moz-context-properties`，
    # `context-fill` 取不到上下文，图标会变黑或不可见。
    #
    # 所以颜色写进图里，三个使用方共用一张，行为一致。
    colored = Image.new("RGBA", canvas.size, SHAPE_COLOR + (0,))
    colored.putalpha(canvas.getchannel("A"))
    colored.save(RASTER)

    import base64

    payload = base64.b64encode(open(RASTER, "rb").read()).decode("ascii")
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'width="{SVG_SIZE}" height="{SVG_SIZE}" '
        f'viewBox="0 0 {CANVAS} {CANVAS}">\n'
        f"  <!-- 蓝色鲸鱼剪影；固定色，三个使用方（工具栏/侧栏标题/侧栏导航）共用 -->\n"
        f'  <image x="0" y="0" width="{CANVAS}" height="{CANVAS}" '
        f'xlink:href="data:image/png;base64,{payload}" '
        f'href="data:image/png;base64,{payload}"/>\n'
        f"</svg>\n"
    )
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(svg)

    print(f"写出 {RASTER}（中间产物，{canvas.size[0]}x{canvas.size[1]}）")
    print(f"写出 {OUT}（外在尺寸 {SVG_SIZE}x{SVG_SIZE}，嵌入位图 {len(payload)} 字节）")
    print(f"  鲸鱼缩放后 {inner[0]}x{inner[1]}（{CANVAS} 画布下的像素），无描边")

if __name__ == "__main__":
    main()
