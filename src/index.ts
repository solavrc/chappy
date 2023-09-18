import { ChannelType, Client, Events, GatewayIntentBits } from 'discord.js'
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { getChatCompletionMessage, trimMessagesToTokenLimit } from './chat_gpt'
import OpenAI from 'openai'

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
  client.on(Events.MessageCreate, async message => {
    try {
      if (message.mentions.has(client.user?.id!) && message.author.id !== client.user?.id) {
        if (message.channel.isThread()) {
          const threadMessages = await message.channel.messages.fetch()
          const messages = await threadMessages.reverse().reduce<Promise<ChatCompletionMessageParam[]>>(async (messages, message) =>
            [...await messages, await getChatCompletionMessage(client, message)], Promise.resolve([]))
          const { object, id, model, choices, usage } = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: trimMessagesToTokenLimit(messages, 4096),
          })
          console.log(JSON.stringify({ object, id, model, messages, choices, usage }))
          await message.reply({ content: choices.at(0)?.message.content! })
        } else if (message.channel.type === ChannelType.GuildText) {
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
              { role: 'system', content: '概要を日本語100文字以内でタイトルとして抽出してください。' },
              { role: 'user', content: cleanContent },
              { role: 'assistant', content: choices.at(0)?.message.content! }
            ],
          }).then(({ object, id, model, choices, usage }) => {
            console.log(JSON.stringify({ object, id, model, messages, choices, usage }))
            return choices.at(0)?.message.content!
          })
          const thread = await message.channel.threads.create({ name, startMessage: message, autoArchiveDuration: 60 * 24 })
          await thread.send({ content: choices.at(0)?.message.content! })
        }
      }
    } catch (error) {
      console.error(error)
      await message.reply({ content: (error as Error).name })
    }
  })
  await client.login(DISCORD_BOT_TOKEN)
})(process.env)
