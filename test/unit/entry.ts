/**
 * 单元测试的打包入口。
 *
 * 为什么这样组织：src/dsh/*.ts 是喂给 esbuild 的模块，里面用到 Zotero 沙箱全局。
 * 直接从 .mjs 测试里 import .ts 需要额外的 loader，而把插件 bundle 整段塞进 vm 又会被
 * IIFE 包装破坏。这里用 esbuild 把**被测试的模块本身**打成一份 ESM 产物，
 * 只导出纯函数；沙箱全局在这些函数被执行前不会被触碰。
 *
 * 由 npm run test:unit 负责：先 esbuild 打包本文件，再用 mocha 跑断言。
 */

export {
  encodeBase64Url,
  encodeBase64UrlString,
  decodeBase64Url,
} from "../../src/dsh/base64url";
export { parseCredentials } from "../../src/dsh/credentials";
export { decodeSecret, hmacSha256 } from "../../src/dsh/crypto";
export {
  buildCookieParts,
  cookieNameFor,
  signCookieValue,
} from "../../src/dsh/auth";
// ⚠️ 这里原有 `resolveDshHome` / `resolvePort` —— 它们只服务于
// 已删除的共享模式（桌面版 Harness 的 DSH_HOME 与端口解析），实现与对应单测均已删除。
export { defaultDshHome, resolveUserHome } from "../../src/dsh/config";
export { DshClient, DshRpcError, newRpcId } from "../../src/dsh/rpc";
export {
  canSend,
  initialState,
  reduce,
  replay,
  statusLine,
  toView,
  __resetMessageSeq,
} from "../../src/chat/state";
// 多段助手正文的合并（真机"回答停在半句"的根因）
export { mergeResponseText } from "../../src/chat/mergeText";
export {
  baseName,
  buildPrompt,
  splitIntoChunks,
  workspaceDirName,
} from "../../src/papers/workspace";
export {
  BUILTIN_COMMANDS,
  buildCommandQuestion,
  findCommand,
  parseCustomCommands,
} from "../../src/chat/commands";
export {
  buildMarkdown,
  buildNoteHtml,
  buildNoteTitle,
  buildSessionNoteTitle,
  escapeHtml,
  markdownToHtml,
} from "../../src/notes/writeback";
export {
  AGENTS_BLOCK_END,
  AGENTS_BLOCK_START,
  SKILL_NAME,
  buildAgentsBlock,
  buildSkillFile,
  mergeAgentsFile,
} from "../../src/dsh/skill";
export { removeAgentsBlock } from "../../src/dsh/install";
// 集成测试（假 Zotero/dsh 环境）用到的编排层
export {
  preparePaperWorkspace,
  resolvePaperRef,
} from "../../src/papers/prepare";
export {
  saveAnswerAsHighlight,
  saveAnswerAsNote,
} from "../../src/notes/writeback";
// 面板日志的并发写入（丢行是本项目一次严重的排查误导，见 runLog.ts）
export { appendPanelLog } from "../../src/dsh/runLog";
// 标签差异计算（setTags 工具与写回都靠它；破坏性操作必须可测）
export { diffTags, isSystemTag } from "../../src/dsh/tagDiff";
// Zotero 工具调用协议（输入是模型写的 JSON，必须宽容且报错可操作）
export {
  READ_OPS,
  WRITE_OPS,
  DESTRUCTIVE_OPS,
  argInt,
  argString,
  argStringArray,
  describeOps,
  isDestructiveOp,
  isKnownOp,
  parseToolCall,
} from "../../src/dsh/zoteroTool";
// ask_user_question 的解析（选项在**工具参数**里，不在正文里 —— 真机反复踩过）
export {
  ALLOWED_ITEM_TYPES,
  ASK_USER_TOOL,
  formatAnswersForSteer,
  normalizeItemType,
  parseAskUserQuestions,
} from "../../src/dsh/askUser";
// 工作区 README 的拼装（`buildSkillFile` 已在上面导出，勿重复）
export { buildWorkspaceReadme } from "../../src/modules/sessionPane";
// 模型配置（API Key 与推理等级）的纯逻辑部分
export {
  API_KEY_REF,
  hasCredentialRef,
  setCredentialRef,
  validateBaseUrl,
} from "../../src/dsh/modelConfig";
// 自定义 provider（GLM / Moonshot / 自建端点）的纯逻辑
export {
  SUPPORTED_APIS,
  PI_AI_PACKAGE,
  MANAGED_START,
  MANAGED_END,
  credentialRefForRoute,
  validateProvider,
  validateEndpointUrl,
  buildProviderPatch,
  mergeManagedBlock,
  extractManagedBlock,
  ensurePiAiBundle,
  compositionNeedsRestart,
} from "../../src/dsh/providers";
export { ChatTransport } from "../../src/chat/transport";

// 论文检索与全文获取（不走 dsh 的 web search）的纯逻辑
export {
  buildCrossrefSearch,
  doiUrl,
  formatCandidates,
  isPlausiblePdfUrl,
  itemTypeFromDataCite,
  parseDataCite,
  looksLikeDoi,
  looksPaywalled,
  normalizeDoi,
  PAPER_NEXT_STEP_HINT,
  TOOL_CHOICE_HINT,
  parseCrossrefItems,
  pickOpenAccessPdf,
  rankCandidates,
  stripJats,
  validatePaperQuery,
} from "../../src/dsh/paperSearch";
// 只拿纯函数（attachBestPdf 会发网络请求，不在单测里跑）
export { isPdfBytes } from "../../src/dsh/paperFetch";
