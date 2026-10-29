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

/**
 * What a delegating Agent needs to know about permissions.
 *
 * DSH pins a child's approval policy to `never` at spawn, so a subagent can
 * never pop an approval prompt itself: an escalation it asks for is refused on
 * the spot. Telling the model this up front stops it from burning turns on retry
 * loops, and points it at the two levers that do work — switch the preset before
 * delegating (children inherit `auto` / `danger-full-access`), or report the
 * blocker back so the root can act.
 */
export const SUBAGENT_PERMISSION_GUIDE = [
  '【子代理权限】',
  '1. 子代理的审批策略在派发时被固定为 never：它自己请求提权会被立即拒绝，不会弹卡片。',
  '2. 如果这一轮需要子代理做工作区外的操作，先用 `/dsh permission set auto`（或 `danger-full-access`）再派发——子代理会继承同一个预设。',
  '3. 子代理被权限墙挡住时，让它把「需要什么权限」写进最终结果，由你决定下一步，不要在子代理里反复重试。',
  '4. `workspace-write` 预设不会被子代理继承，只影响当前会话。',
].join('\n')
