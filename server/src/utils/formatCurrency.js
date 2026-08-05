/**
 * 使用 Intl.NumberFormat 格式化金额。
 *
 * @param {number} amount - 要格式化的金额数值
 * @param {string} [locale='zh-CN'] - BCP 47 语言标签，默认为 'zh-CN'
 * @param {string} [currency='CNY'] - ISO 4217 货币代码，默认为 'CNY'
 * @returns {string} 格式化后的货币字符串，如 "¥1,234.56"
 *
 * @example
 * formatCurrency(1234.56);
 * // => "¥1,234.56"
 *
 * @example
 * formatCurrency(1234.56, 'en-US', 'USD');
 * // => "$1,234.56"
 *
 * @example
 * formatCurrency(1234.56, 'ja-JP', 'JPY');
 * // => "￥1,235"
 */
export function formatCurrency(amount, locale = 'zh-CN', currency = 'CNY') {
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
  }).format(n);
}

export default formatCurrency;
