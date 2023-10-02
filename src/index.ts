import { ChannelType, Client, Events, GatewayIntentBits } from 'discord.js'
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { getChatCompletionMessage, trimMessagesToTokenLimit } from './chat_gpt'
import OpenAI from 'openai'
import { createServer } from 'http'

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
})

process.on('SIGTERM', () => process.exit(0));

(async ({ DISCORD_BOT_TOKEN, OPENAI_API_KEY }) => {
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY })
  client.on(Events.ClientReady, async _client => {
    createServer((_, response) => response.writeHead(204).end()).listen(8080)
  })
  client.on(Events.MessageCreate, async message => {
    try {
      if (
        message.author.bot
        || message.mentions.everyone /** @see https://old.discordjs.dev/#/docs/discord.js/main/class/MessageMentions?scrollTo=everyone */
        || !message.mentions.has(client.user!)
      ) return

      if (message.channel.isThread()) {
        await message.channel.sendTyping()
        const threadMessages = await message.channel.messages.fetch()
        const messages = await threadMessages.reverse().reduce<Promise<ChatCompletionMessageParam[]>>(async (messages, message) =>
          [...await messages, await getChatCompletionMessage(client, message)], Promise.resolve([]))
        const { object, id, model, choices, usage } = await openai.chat.completions.create({
          model: 'gpt-4',
          messages: trimMessagesToTokenLimit(messages, 4096),
        })
        console.log(JSON.stringify({ object, id, model, messages, choices, usage }))
        await message.reply({ content: choices.at(0)?.message.content!, failIfNotExists: false })
      } else if (message.channel.type === ChannelType.GuildText) {
        const thread = await message.channel.threads.create({ name: '返信中...', startMessage: message, autoArchiveDuration: 60 * 24 })
        await thread.sendTyping()
        const { cleanContent } = message
        const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: cleanContent }]
        const { object, id, model, choices, usage } = await openai.chat.completions.create({
          model: 'gpt-4',
          messages,
        })
        console.log(JSON.stringify({ object, id, model, messages, choices, usage }))
        const name = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: '概要を日本語30文字程度でタイトルとして抽出してください。' },
            { role: 'user', content: cleanContent },
            { role: 'assistant', content: choices.at(0)?.message.content! }
          ],
        }).then(({ object, id, model, choices, usage }) => {
          console.log(JSON.stringify({ object, id, model, messages, choices, usage }))
          return choices.at(0)?.message.content?.slice(0, 50)!
        })
        await thread.edit({ name })
        await thread.send({ content: choices.at(0)?.message.content! })
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error(JSON.stringify({ ...error, name: error.name, message: error.message, stack: error.stack }))
        await message.reply({ content: JSON.stringify({ name: error.name, message: error.message }), failIfNotExists: false })
      } else {
        throw error
      }
    }
  })
  await client.login(DISCORD_BOT_TOKEN)
})(process.env)
