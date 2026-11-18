import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

export type TextKey = keyof typeof en;
const resources: Record<string, Record<string, string>> = { en, "zh-CN": zhCN };

/** The language of the page: Chinese when the browser asks for it, else English. */
export function locale(): string {
  return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

/** Looks a label up and fills `{{name}}` placeholders. */
export function t(key: string, values?: Record<string, string | number>): string {
  const table = resources[locale()] ?? en;
  // A count picks the plural form, such as openComments_one or openComments_other.
  const plural = typeof values?.count === "number" ? `${key}_${new Intl.PluralRules(locale()).select(values.count)}` : null;
  const text = (plural && (table[plural] ?? (en as Record<string, string>)[plural])) || table[key] || (en as Record<string, string>)[key] || key;
  return values ? text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values[name] ?? "")) : text;
}
