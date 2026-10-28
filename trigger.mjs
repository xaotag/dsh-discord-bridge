import { Client, GatewayIntentBits } from 'discord.js'
import fs from 'node:fs'

const env = fs.readFileSync('/home/ecs-user/.dsh/discord-bridge.env', 'utf8')
const token = env.match(/DISCORD_BOT_TOKEN=(.+)/)?.[1]?.trim()
const ownerId = env.match(/DSH_DISCORD_OWNER_ID=(\d+)/)?.[1]?.trim()

// 用 owner 身份发消息不现实（需要 user token），
// 改为：直接调用插件的 user-questions answerer 路径不可行，
// 所以这里只打印说明。
console.log('owner:', ownerId)
