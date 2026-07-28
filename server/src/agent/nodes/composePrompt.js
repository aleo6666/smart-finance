import { composeSystemContext } from '../prompts.js'

export function createComposePromptNode({
  compose = composeSystemContext
} = {}) {
  if (typeof compose !== 'function') {
    throw new TypeError('compose must be a function')
  }

  return async state => {
    compose(state)
    return {}
  }
}
