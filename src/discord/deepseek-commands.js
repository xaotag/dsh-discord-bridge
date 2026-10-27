import { SlashCommandBuilder } from 'discord.js'

const modelOption = (required = false) =>
  (o) =>
    o
      .setName('model')
      .setDescription('DeepSeek 模型 ID，例如 deepseek-chat / deepseek-reasoner')
      .setRequired(required)
      .setAutocomplete(true)

export const deepseekCommand = new SlashCommandBuilder()
  .setName('deepseek')
  .setDescription('DeepSeek 官方 REST API（分组命令，不经过 DSH Agent）')
  .addSubcommandGroup((group) =>
    group
      .setName('models')
      .setDescription('GET /models')
      .addSubcommand((c) => c.setName('list').setDescription('列出 DeepSeek 官方模型')),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('balance')
      .setDescription('GET /user/balance')
      .addSubcommand((c) => c.setName('get').setDescription('查询 DeepSeek 账户余额')),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('chat')
      .setDescription('POST /chat/completions（流式）')
      .addSubcommand((c) =>
        c
          .setName('create')
          .setDescription('创建一次流式 Chat Completion')
          .addStringOption((o) => o.setName('prompt').setDescription('用户提示词').setRequired(true))
          .addStringOption((o) => o.setName('system').setDescription('系统提示词'))
          .addStringOption(modelOption(false))
          .addNumberOption((o) =>
            o.setName('temperature').setDescription('0–2，默认 API 默认值').setMinValue(0).setMaxValue(2),
          )
          .addIntegerOption((o) =>
            o.setName('max_tokens').setDescription('最大输出 token').setMinValue(1),
          ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('fim')
      .setDescription('POST /beta/completions（FIM beta）')
      .addSubcommand((c) =>
        c
          .setName('create')
          .setDescription('创建一次 FIM Completion')
          .addStringOption((o) => o.setName('prompt').setDescription('前缀内容').setRequired(true))
          .addStringOption((o) => o.setName('suffix').setDescription('后缀内容'))
          .addStringOption(modelOption(false))
          .addIntegerOption((o) =>
            o.setName('max_tokens').setDescription('最大输出 token').setMinValue(1),
          ),
      ),
  )

export const DEEPSEEK_COMMAND_BODY = deepseekCommand.toJSON()

export const DEEPSEEK_HELP_TEXT = [
  '**DeepSeek 官方 API 分组**',
  '`/deepseek models list` — GET /models',
  '`/deepseek balance get` — GET /user/balance',
  '`/deepseek chat create` — POST /chat/completions（流式）',
  '`/deepseek fim create` — POST /beta/completions（FIM beta）',
].join('\n')

export function normalizeDeepSeekInteraction(interaction) {
  if (!interaction?.isChatInputCommand?.() || interaction.commandName !== 'deepseek') return undefined
  const group = interaction.options.getSubcommandGroup(false)
  const command = interaction.options.getSubcommand()
  const options = {
    prompt: interaction.options.getString('prompt') || undefined,
    system: interaction.options.getString('system') || undefined,
    model: interaction.options.getString('model') || undefined,
    suffix: interaction.options.getString('suffix') || undefined,
    temperature: interaction.options.getNumber('temperature') ?? undefined,
    maxTokens: interaction.options.getInteger('max_tokens') ?? undefined,
  }
  return { group, command, options }
}

export function parseDeepSeekTextCommand(text) {
  const match = /^[!/]deepseek\s+(models|balance|chat|fim)\s+([a-z-]+)(?:\s+([\s\S]+))?$/i.exec(
    String(text || '').trim(),
  )
  if (!match) return undefined
  return { group: match[1].toLowerCase(), command: match[2].toLowerCase(), arg: match[3] }
}
