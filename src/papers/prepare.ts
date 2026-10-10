/**
 * 论文上下文准备：单篇面板与批量处理共用。
 *
 * 抽出来的原因：两条路径都需要"定位父条目 → 写工作区文件 → 给出可供 Agent 读取的文件清单"，
 * 逻辑只应有一份（此前面板与批量各写了一遍，容易漂移）。
 */

import type { DshRuntimeConfig } from "../dsh/config";
import {
  buildMetadataText,
  writePaperWorkspace,
  type PaperFiles,
  type PaperItemRef,
} from "./workspace";

export interface PreparedPaper {
  ref: PaperItemRef;
  metadataText: string;
  files: PaperFiles;
}

/** 从任意条目（可能是 PDF 附件）解析出"文献父条目 + 附件 id" */
export function resolvePaperRef(item: Zotero.Item): PaperItemRef | undefined {
  try {
    const parentID = (item as unknown as { parentItemID?: number | false })
      .parentItemID;
    const owner = parentID ? (Zotero.Items.get(parentID) ?? item) : item;
    if (!owner) return undefined;
    return {
      itemID: owner.id,
      libraryID: owner.libraryID,
      key: owner.key,
      attachmentID: item.isPDFAttachment?.() ? item.id : undefined,
    };
  } catch (error) {
    ztoolkit.log("[DSH] 解析文献条目失败", error);
    return undefined;
  }
}

/** 确保论文工作区文件已就绪；返回元数据文本与文件信息 */
export async function preparePaperWorkspace(
  config: DshRuntimeConfig,
  item: Zotero.Item,
  options: { chunkBytes?: number } = {},
): Promise<PreparedPaper | undefined> {
  const ref = resolvePaperRef(item);
  if (!ref) return undefined;
  const owner = Zotero.Items.get(ref.itemID) ?? item;
  const metadataText = buildMetadataText(owner);
  const files = await writePaperWorkspace({
    config,
    ref,
    item: owner,
    chunkBytes: options.chunkBytes,
  });
  return { ref, metadataText, files };
}
