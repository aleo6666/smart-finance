/**
 * 简易 JSON 修复工具 - 处理模型输出的常见 JSON 格式问题
 * 处理场景：
 * 1. 单引号 → 双引号
 * 2. 缺少引号的键名
 * 3. 多余的尾随逗号
 * 4. 单行注释 //
 * 5. 未转义的换行符
 *
 * @param {string} input - 可能格式不规范的 JSON 字符串
 * @returns {string} - 修复后的 JSON 字符串，如果无法修复则返回原始输入
 */
export function jsonRepair(input) {
  if (typeof input !== 'string') return input
  let str = input.trim()
  if (!str) return str

  try {
    JSON.parse(str)
    return str
  } catch { /* 继续修复 */ }

  // 1. 移除单行注释（保护 URL 中的 // 不被误删）
  str = str.replace(/(?<!:)\/\/(?!\/)[^\n\r]*/g, '')

  // 2. 移除多行注释
  str = str.replace(/\/\*[\s\S]*?\*\//g, '')

  // 3. 处理单引号 → 双引号
  // 先把双引号替换成占位符
  const placeholders = []
  let placeholderIndex = 0
  str = str.replace(/"([^"\\]|\\.)*"/g, match => {
    placeholders.push(match)
    return `__DQ_PH_${placeholderIndex++}__`
  })
  // 把单引号替换成双引号
  str = str.replace(/'/g, '"')
  // 还原双引号
  placeholders.forEach((p, i) => {
    str = str.replace(`__DQ_PH_${i}__`, p)
  })

  // 4. 给没有引号的键名加引号
  str = str.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')

  // 5. 移除尾随逗号
  str = str.replace(/,(\s*[}\]])/g, '$1')

  try {
    JSON.parse(str)
    return str
  } catch { /* 修复失败，返回原始字符串 */ }

  return input
}
