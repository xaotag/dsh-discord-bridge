/**
 * Model catalog queries.
 *
 * Stateless lookups over `ctx.llm`; kept separate from AgentService because they
 * touch no runtime state and are trivially testable on their own.
 */

/** Models a provider offers, or an empty list when the catalog is unavailable. */
export async function listModels(ctx, logger, provider) {
  try {
    return (await ctx.get('llm')?.listModels?.(provider)) || []
  } catch (error) {
    logger?.warn?.('读取模型列表失败:', error?.message || String(error))
    return []
  }
}

/**
 * Selectable reasoning efforts for an exact route.
 *
 * `listModels()` returns catalog entries without capability metadata, so the
 * route has to be resolved to read the adapter's own effort list.
 */
export async function listReasoningEfforts(ctx, logger, provider, model) {
  try {
    const llm = ctx.get('llm')
    if (!llm || !provider || !model) return []
    const info = llm.resolveModelInfo ? await llm.resolveModelInfo(provider, model) : undefined
    return (info?.reasoning?.efforts || []).map((effort) => String(effort.id))
  } catch (error) {
    logger?.warn?.('读取推理等级列表失败:', error?.message || String(error))
    return []
  }
}
