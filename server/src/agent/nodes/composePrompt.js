/**
 * @deprecated 此节点的 compose 逻辑实际上在 graph.js 的 callModel 中通过 composeModelMessages 完成。
 *             此文件保留仅为向后兼容已存在的 graph 实例化代码。
 *             计划在后续重构中移除，届时 callModel 中的 composeModelMessages 调用将移入此处。
 *
 * @see server/src/agent/prompts.js :: composeModelMessages
 */
import { composeSystemContext } from '../prompts.js'

export function createComposePromptNode({
  compose = composeSystemContext
} = {}) {
  if (typeof compose !== 'function') {
    throw new TypeError('compose must be a function')
  }

  return async state => {
    // @deprecated: 实际 prompt 组合已移至 callModel 节点
    // 此处 compose(state) 的返回值未被使用
    compose(state)
    return {}
  }
}
