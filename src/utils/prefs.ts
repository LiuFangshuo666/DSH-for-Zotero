import { config } from "../../package.json";

type PluginPrefsMap = _ZoteroTypes.Prefs["PluginPrefsMap"];

const PREFS_PREFIX = config.prefsPrefix;

/**
 * Get preference value.
 * Wrapper of `Zotero.Prefs.get`.
 * @param key
 */
export function getPref<K extends keyof PluginPrefsMap>(key: K) {
  return Zotero.Prefs.get(`${PREFS_PREFIX}.${key}`, true) as PluginPrefsMap[K];
}

/**
 * Set preference value.
 * Wrapper of `Zotero.Prefs.set`.
 *
 * 与 `getPref` 对称地集中在这里：先前只有 getter，需要写偏好的地方
 * （例如新手引导的"已看过"标记）各自拼前缀字符串 —— 那正是"前缀写错却静默失效"的来源。
 *
 * ⚠️ 第三参 `true` 是"全局偏好"标志，与 `getPref` 保持一致。
 */
export function setPref<K extends keyof PluginPrefsMap>(
  key: K,
  value: PluginPrefsMap[K],
): void {
  Zotero.Prefs.set(`${PREFS_PREFIX}.${key}`, value, true);
}
