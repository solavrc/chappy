import { ChannelType, Client, Events, GatewayIntentBits, Message } from 'discord.js'
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { createServer } from 'http'
import { getChatCompletionMessage } from './chat_gpt'
import { Threads } from 'openai/resources/beta'
import axios from 'axios'
import OpenAI, { toFile } from 'openai'

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
})

process.on('SIGTERM', () => process.exit(0));

(async ({ DISCORD_BOT_TOKEN, OPENAI_API_KEY, OPENAI_ASSISTANT_ID }) => {
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY })
  const assistant_id: string = OPENAI_ASSISTANT_ID ?? await openai.beta.assistants.list({ limit: 1 }).then(({ data: [{ id }] }) => id)
  const uploadFileFromURL = async (url: string, name?: string) => {
    const { data } = await axios.get(url, { responseType: 'arraybuffer' })
    const { id } = await openai.files.create({ file: await toFile(data, name ?? new URL(url).pathname.split('/').at(-1)), purpose: 'assistants' })
    return id
  }
  const runAssistant = async (assistant_id: string, thread_id: string) => {
    let { id, object, model } = await openai.beta.threads.runs.create(thread_id, { assistant_id })
    loop: while (true) {
      const { status, last_error } = await openai.beta.threads.runs.retrieve(thread_id, id)
      switch (status) {
        case 'completed':
          break loop
        case 'failed':
          if (last_error?.code === 'rate_limit_exceeded')
            throw new Error(last_error.message)
          const { id: run_id } = await openai.beta.threads.runs.create(thread_id, { assistant_id })
          id = run_id
          continue loop
        case 'queued':
        case 'in_progress':
        default:
          await new Promise(resolve => setTimeout(resolve, 1000))
          continue loop
      }
    }
    const { data: messages } = await openai.beta.threads.messages.list(thread_id, { order: 'desc' })
    console.log(JSON.stringify({ object, id, model, messages }))
    return messages
  }
  const createEmbeds = (annotations: (Threads.Messages.MessageContentText.Text.FilePath | Threads.Messages.MessageContentText.Text.FileCitation)[]) =>
    annotations
      .filter((annotation): annotation is Threads.Messages.MessageContentText.Text.FileCitation => annotation.type === 'file_citation')
      .map(({ text, file_citation: { quote } }) => ({ description: `${text}${quote}` }))

  client.on(Events.ClientReady, async _client => {
    createServer((_, response) => response.writeHead(204).end()).listen(8080)
  })
  client.on(Events.MessageCreate, async message => {
    try {
      const isActivateIntentMessage = (message: Message) =>
        message.mentions.has(client.user!)
        && !message.mentions.everyone /** @see https://old.discordjs.dev/#/docs/discord.js/main/class/MessageMentions?scrollTo=everyone */
        && !message.author.bot
      const isChappyThread = async (message: Message) =>
        message.channel.isThread()
        && message.channel.fetchStarterMessage()
          .then(message => isActivateIntentMessage(message!))

      if (message.author.bot || message.author.id === client.user?.id)
        return
      if (await isChappyThread(message)) {
        const [_images, nonImages] = message.attachments.partition(attachment => attachment.contentType?.includes('image/'))
        const thread_id = await message.channel.messages.fetchPinned()
          .then(messages => messages.find(({ cleanContent }) => cleanContent.startsWith('thread_'))?.cleanContent)
        if (thread_id) {
          const file_ids = await Promise.all(nonImages.map(async ({ url, name }) => uploadFileFromURL(url, name)))
          await openai.beta.threads.messages.create(thread_id, {
            role: 'user',
            content: message.cleanContent,
            file_ids,
            metadata: { discord_thread_id: message.thread?.id, discord_message_id: message.id }
          })
          if (isActivateIntentMessage(message)) {
            await message.channel.sendTyping()
            const [{ content }] = await runAssistant(assistant_id, thread_id)
            const { text: { annotations, value } } = content.find((content): content is Threads.Messages.MessageContentText => content.type === 'text')!
            await message.reply({
              content: value,
              embeds: createEmbeds(annotations)
            })
          }
        } else if (isActivateIntentMessage(message)) {
          const threadMessages = await message.channel.messages.fetch()
          const messages = await threadMessages.reverse().reduce<Promise<ChatCompletionMessageParam[]>>(async (messages, message) =>
            [...await messages, await getChatCompletionMessage(client, message)], Promise.resolve([]))
          const { object, id, model, choices, usage } = await openai.chat.completions.create({
            model: 'gpt-4-vision-preview',
            messages,
            max_tokens: 4096,
          })
          console.log(JSON.stringify({ object, id, model, messages, choices, usage }))
          await message.reply({ content: choices.at(0)?.message.content!, failIfNotExists: false })
        }
      } else if (message.channel.type === ChannelType.GuildText && isActivateIntentMessage(message)) {
        const name = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: '概要を日本語30文字程度でタイトルとして抽出してください。' },
            { role: 'user', content: message.cleanContent },
          ],
        }).then(({ object, id, model, choices, usage }) => {
          console.log(JSON.stringify({ object, id, model, choices, usage }))
          return choices.at(0)?.message.content?.slice(0, 30)!
        })
        const thread = await message.channel.threads.create({ name, startMessage: message, autoArchiveDuration: 60 * 24 })
        await thread.sendTyping()
        const [images, nonImages] = message.attachments.partition(attachment => attachment.contentType?.includes('image/'))
        /**
         * 画像が添付されたケースとそれ以外で処理を分ける
         * > Image files aren't supported today, but we plan to add support for them in the coming months.
         * @see https://platform.openai.com/docs/assistants/overview/step-3-add-a-message-to-a-thread
         */
        if (images.size === 0) {
          const file_ids = await Promise.all(nonImages.map(async ({ url, name }) => uploadFileFromURL(url, name)))
          const { id: thread_id } = await openai.beta.threads.create({
            messages: [{
              role: 'user',
              content: message.cleanContent,
              file_ids,
              metadata: {
                discord_thread_id: thread.id,
                discord_message_id: message.id
              }
            }]
          })
          /** `thread_id` を参照のためピン留めする */
          await thread.send({ content: thread_id })
            .then(message => message.pin())
          const [{ content }] = await runAssistant(assistant_id, thread_id)
          const { text: { annotations, value } } = content.find((content): content is Threads.Messages.MessageContentText => content.type === 'text')!
          await thread.send({ content: value, embeds: createEmbeds(annotations) })
        } else {
          const messages: ChatCompletionMessageParam[] = [await getChatCompletionMessage(client, message)]
          const { object, id, model, choices, usage } = await openai.chat.completions.create({
            model: 'gpt-4-vision-preview',
            messages,
            max_tokens: 4096,
          })
          console.log(JSON.stringify({ object, id, model, messages, choices, usage }))
          await thread.send({ content: choices.at(0)?.message.content! })
        }
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
