import { SlashCommandBuilder } from 'discord.js'

export const HELP_TEXT = [
  '**dsh-discord-bridge 官方命令分组**',
  '',
  '**/dsh session**',
  '`status` 查看当前 Channel 的 Session、模型和推理等级',
  '`list` 列出可绑定的 live / 持久化 Session',
  '`bind <sessionId>` 将当前频道绑定到已有 Session',
  '`new` 当前 Channel 新建独立 Session',
  '`stop` 停止当前任务',
  '',
  '**/dsh model**',
  '`list` 列出当前 provider 可用模型',
  '`set <provider>/<model>` 切换模型（不更换 Session）',
  '`reasoning <off|low|high|max>` 切换推理等级（不更换 Session）',
  '',
  '**/dsh task**',
  '`ask <文本>` 提交任务',
  '`steer <文本>` 引导当前任务最近的步骤',
  '`stop` 停止当前任务',
  '',
  '**/dsh thread**',
  '`create <标题>` 手动创建子线程',
  '`info` 查看当前 Channel/Thread 信息',
  '',
  '**/dsh system**',
  '`help` 本帮助',
  '`ping` 检查 Bot/网关延迟',
  '`audit` 最近操作日志（不含对话内容）',
].join('\n')

const modelValueOption = (o) =>
  o
    .setName('value')
    .setDescription('provider/model，例如 deepseek-official/deepseek-flash')
    .setRequired(true)
    .setAutocomplete(true)

const reasoningValueOption = (o) =>
  o
    .setName('value')
    .setDescription('off | low | high | max')
    .setRequired(true)
    .addChoices(
      { name: 'off', value: 'off' },
      { name: 'low', value: 'low' },
      { name: 'high', value: 'high' },
      { name: 'max', value: 'max' },
    )

export const dshCommand = new SlashCommandBuilder()
  .setName('dsh')
  .setDescription('DeepSeek Harness 官方命令（按 session/model/task/thread/system 分组）')
  .addSubcommandGroup((group) =>
    group
      .setName('session')
      .setDescription('Session 生命周期')
      .addSubcommand((c) => c.setName('status').setDescription('查看当前 Session 状态'))
      .addSubcommand((c) => c.setName('list').setDescription('列出当前 live / 已持久化的 Session'))
      .addSubcommand((c) =>
        c
          .setName('bind')
          .setDescription('将当前 Discord 频道绑定到指定 DSH Session')
          .addStringOption((o) =>
            o
              .setName('session')
              .setDescription('Session ID')
              .setRequired(true)
              .setAutocomplete(true),
          ),
      )
      .addSubcommand((c) => c.setName('new').setDescription('创建并绑定新的独立 Session'))
      .addSubcommand((c) => c.setName('stop').setDescription('停止当前任务')),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('model')
      .setDescription('模型与推理等级')
      .addSubcommand((c) => c.setName('list').setDescription('列出当前 provider 可用模型'))
      .addSubcommand((c) =>
        c
          .setName('set')
          .setDescription('切换本频道模型（不更换 Session）')
          .addStringOption(modelValueOption),
      )
      .addSubcommand((c) =>
        c
          .setName('reasoning')
          .setDescription('切换本频道推理等级（不更换 Session）')
          .addStringOption(reasoningValueOption),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('task')
      .setDescription('任务执行')
      .addSubcommand((c) =>
        c
          .setName('ask')
          .setDescription('向当前频道提交任务')
          .addStringOption((o) => o.setName('text').setDescription('任务内容').setRequired(true)),
      )
      .addSubcommand((c) =>
        c
          .setName('steer')
          .setDescription('将文本引导到当前任务最近的步骤')
          .addStringOption((o) => o.setName('text').setDescription('引导内容').setRequired(true)),
      )
      .addSubcommand((c) => c.setName('stop').setDescription('停止当前任务')),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('thread')
      .setDescription('子线程隔离')
      .addSubcommand((c) =>
        c
          .setName('create')
          .setDescription('手动创建子线程')
          .addStringOption((o) => o.setName('name').setDescription('线程标题').setRequired(true)),
      )
      .addSubcommand((c) => c.setName('info').setDescription('查看当前频道/线程信息')),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('system')
      .setDescription('系统与诊断')
      .addSubcommand((c) => c.setName('help').setDescription('查看帮助'))
      .addSubcommand((c) => c.setName('ping').setDescription('检查 Bot/网关延迟'))
      .addSubcommand((c) => c.setName('audit').setDescription('查看当前频道最近的操作日志（不含对话内容）'))
      .addSubcommand((c) =>
        c
          .setName('ask')
          .setDescription('测试：让 bot 发起一次 ask_user_question')
          .addStringOption((o) => o.setName('question').setDescription('问题内容')),
      )
      .addSubcommand((c) =>
        c
          .setName('confirm')
          .setDescription('请求一次操作确认（批准/拒绝按钮）')
          .addStringOption((o) =>
            o.setName('action').setDescription('要确认的操作描述').setRequired(true),
          ),
      )
      .addSubcommand((c) =>
        c
          .setName('sudo')
          .setDescription('以 root 执行命令（需在 Discord 审批后由守护进程执行）')
          .addStringOption((o) =>
            o.setName('command').setDescription('要执行的命令').setRequired(true),
          ),
      ),
  )

export const DSH_COMMAND_BODY = dshCommand.toJSON()

export function parseTextCommand(text) {
  const match = /^[!/]dsh\s+(session|model|task|thread|system)\s+([a-z-]+)(?:\s+([\s\S]+))?\s*$/i.exec(
    String(text || '').trim(),
  )
  if (!match) return undefined
  return { group: match[1].toLowerCase(), command: match[2].toLowerCase(), arg: match[3] }
}

/** Depth-first search for an option by name in the raw interaction data. */
function findOption(nodes, name) {
  if (!Array.isArray(nodes)) return undefined
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue
    if (node.name === name && node.value !== undefined && node.value !== null) return node
    const nested = findOption(node.options, name)
    if (nested) return nested
  }
  return undefined
}

function readOption(interaction, name) {
  // Discord clients occasionally drop the focused selection while the server
  // still receives the interaction; read defensively and keep a raw fallback.
  try {
    const value = interaction.options.getString(name)
    if (value !== null && value !== undefined && String(value).length > 0) return String(value)
  } catch {
    /* option absent in a stale command tree */
  }
  try {
    // Group > subcommand > option nests two levels deep, so walk it recursively
    // instead of flattening a single level.
    const raw = findOption(interaction.options.data, name)
    if (raw?.value !== undefined && raw?.value !== null) return String(raw.value)
  } catch {
    /* ignore */
  }
  return undefined
}

export function describeInteraction(interaction) {
  try {
    return JSON.stringify({
      group: interaction.options.getSubcommandGroup(false),
      command: interaction.options.getSubcommand(),
      data: interaction.options.data?.map((option) => ({
        name: option.name,
        type: option.type,
        options: option.options?.map((child) => ({ name: child.name, type: child.type, value: child.value })),
      })),
    })
  } catch (error) {
    return `<unreadable: ${error?.message || String(error)}>`
  }
}

export function normalizeInteraction(interaction) {
  if (!interaction?.isChatInputCommand?.() || interaction.commandName !== 'dsh') return undefined
  const group = interaction.options.getSubcommandGroup(false)
  const command = interaction.options.getSubcommand()
  const arg =
    // `ask` exists in two groups with different option names: /dsh task ask
    // reads `text`, /dsh system ask reads `question`. Accept either, or the
    // second group would silently lose its argument.
    command === 'ask'
      ? readOption(interaction, 'text') ?? readOption(interaction, 'question')
      : command === 'steer'
        ? readOption(interaction, 'text')
        : command === 'set' || command === 'reasoning' || command === 'model'
          ? readOption(interaction, 'value')
          : command === 'create'
            ? readOption(interaction, 'name')
            : command === 'bind'
              ? readOption(interaction, 'session')
              : command === 'confirm'
                ? readOption(interaction, 'action')
                : command === 'sudo'
                  ? readOption(interaction, 'command')
                  : undefined
  // Backward compatibility for Discord clients still caching the pre-group
  // `/dsh status|new|model|reasoning|ask|steer|stop|help` command tree.
  const legacy = {
    status: ['session', 'status'],
    new: ['session', 'new'],
    list: ['session', 'list'],
    bind: ['session', 'bind'],
    stop: ['task', 'stop'],
    model: ['model', 'set'],
    reasoning: ['model', 'reasoning'],
    ask: ['task', 'ask'],
    steer: ['task', 'steer'],
    help: ['system', 'help'],
    audit: ['system', 'audit'],
    ask: ['system', 'ask'],
    confirm: ['system', 'confirm'],
    sudo: ['system', 'sudo'],
  }
  if (!group && legacy[command]) {
    const [g, c] = legacy[command]
    return { group: g, command: c, arg }
  }
  return { group, command, arg }
}
