/**
 * Pure mention helpers shared by the message router and tests.
 *
 * Discord serializes user mentions as `<@1234>` (legacy) or `<@!1234>` (member
 * form). Both must trigger the bot and both must be stripped before the text
 * reaches the model.
 */
export function mentionsUser(mentions, userId) {
  if (!userId) return false
  return mentions?.users?.has?.(userId) === true
}

export function stripMentions(content, userId) {
  if (!content) return ''
  if (!userId) return String(content).trim()
  return String(content).replace(new RegExp(`<@!?${userId}>`, 'g'), '').trim()
}
