/**
 * Presentation guidance injected into the Agent that talks to Discord.
 *
 * A subagent cannot ask a human itself (DSH rejects a delegated caller), so the
 * root Agent asks on its behalf. That means the bridge only learns which child a
 * question is about from the caller: the child's catalog label has to be named
 * in `header`, or the card cannot be filed under the child's thread. Keep this
 * short — it is a presentation rule, not a capability change.
 */
export const SUBAGENT_QUESTION_GUIDE = [
  '【Discord 子代理线程】',
  '1. 每个子代理在 Discord 上有自己的子线程（🧩 <label>），父卡片只用 🧵 链接指向它。',
  '2. 如果你替某个子代理向用户提问（ask_user_question），把该子代理的 label（即 spawn_teammate 的 description）写进问题的 header，例如 header 为「<label>」。桥接会把提问卡发进那个子线程；header 不含任何子代理 label 时，卡片留在父频道。',
].join('\n')
