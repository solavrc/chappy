import { ok } from 'assert'
import axios from 'axios'
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlagsBitField,
  type Attachment,
  type Message,
  type PartialMessage,
} from 'discord.js'
import { createServer } from 'http'
import OpenAI, { toFile } from 'openai'
import { type Threads, type Assistants } from 'openai/resources/beta'
import { type ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { getChatCompletionMessage } from './chat_gpt'
import ThreadRelation from './thread_relation'

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
})
const uploadAttachments = async (openai: OpenAI, { url, name, contentType }: Attachment): Promise<string> => {
  const { data } = await axios.get(url, { responseType: 'arraybuffer' })
  const { id } = await openai.files.create({
    file: await toFile(data, name ?? new URL(url).pathname.split('/').at(-1)),
    // @ts-ignore
    purpose: contentType?.includes('image/') ? 'vision' : 'assistants', /** @see https://github.com/openai/openai-node/pull/851 */
  })
  return id
}
const toOpenAIAttachments = (openai: OpenAI, message: Message | PartialMessage): Promise<[Threads.Messages.MessageCreateParams.Attachment[], Threads.Messages.ImageFileContentBlock[]]> => {
  const [images, nonImages] = message.attachments.partition(attachment => attachment.contentType?.includes('image/'))
  return Promise.all([
    Promise.all(nonImages.map<Promise<Threads.Messages.MessageCreateParams.Attachment>>(image => uploadAttachments(openai, image).then(file_id => ({ file_id, tools: [{ type: 'code_interpreter' }] })))),
    Promise.all(images.map<Promise<Threads.Messages.ImageFileContentBlock>>(image => uploadAttachments(openai, image).then(file_id => ({ type: 'image_file', image_file: { file_id, detail: 'auto' } }))))
  ])
}
const runAssistantAndResponse = async (openai: OpenAI, assistant_id: string, thread_id: string, message: Message | PartialMessage): Promise<void> => {
  await new Promise<void>(async (resolve, reject) => {
    /** @see https://discord.com/developers/docs/topics/rate-limits */
    const replyIntervalMs = 1000
    let lastEvent: Assistants.AssistantStreamEvent | undefined
    let intervalId: NodeJS.Timeout | undefined
    let replyMessage: Message | undefined
    let content = ''
    try {
      replyMessage = message.channel.isThread()
        ? await message.reply({ content: '...' })
        : await message.thread?.send({ content: '...' })
      const stream = openai.beta.threads.runs.stream(thread_id, { assistant_id, stream: true, metadata: { discord_message_id: message.id, discord_thread_id: message.thread?.id } as Metadata })
      stream.on('event', async (event) => {
        lastEvent = event
        switch (event.event) {
          case 'thread.run.created':
            intervalId = setInterval(async () => {
              /**
               * DiscordAPIError[50035]: Invalid Form Body
               * content[BASE_TYPE_MAX_LENGTH]: Must be 2000 or fewer in length.
               *
               * `Util.splitMessage()` has been removed. This utility method is something the developer themselves should do.
               * @see https://discordjs.guide/additional-info/changes-in-v14.html#util
               */
              const maxContentLength = 2000
              const description = `[${new Date().toISOString()}] ${lastEvent?.event}`
              if (content.length > maxContentLength) {
                const chunks: string[] = []
                for (let index = 0; index < content.length; index += maxContentLength) {
                  chunks.push(content.slice(index, index + maxContentLength))
                }
                content = chunks.at(-1)!
                await replyMessage?.edit({ content: chunks.shift(), embeds: [] })
                for await (const chunk of chunks) {
                  replyMessage = await replyMessage?.reply({ content: chunk, embeds: [{ description }] })
                }
              } else if (replyMessage?.cleanContent !== content) {
                await replyMessage?.edit({ content, embeds: [{ description }] })
              } else {
                await replyMessage?.edit({ embeds: [{ description }] })
              }
            }, replyIntervalMs)
            break
          case 'thread.message.delta':
            content += event.data.delta.content?.filter(content => content.type === 'text')
              .reduce((text, chunk) => text + chunk.text?.value, '')
            break
          case 'thread.message.completed':
            /** @todo 添付ファイル処理 */
            break
          case 'thread.run.completed':
            await new Promise(resolve => setTimeout(resolve, replyIntervalMs)) /** draining */
            clearInterval(intervalId)
            await Promise.all([
              await replyMessage?.edit({ embeds: [] }),
              await replyMessage?.react('✅')
            ])
            /** @todo logging */
            resolve()
            break
          case 'error':
          case 'thread.run.cancelled':
          case 'thread.run.expired':
          case 'thread.run.failed':
            throw new Error(JSON.stringify(event))
        }
      })
    } catch (error) {
      reject(error)
    }
  })
}
const isActivateIntentMessage = (message: Message | PartialMessage) =>
  message.mentions.has(client.user!)
  && !message.mentions.everyone /** @see https://old.discordjs.dev/#/docs/discord.js/main/class/MessageMentions?scrollTo=everyone */
  && !message.author?.bot
const toCleanContent = ({ author, content, cleanContent, client: { user } }: Message | PartialMessage) => {
  ok(author && cleanContent && content && user)
  return author
    ? content.replace(user.toString(), `${author.displayName}:`)
    : cleanContent
}

interface Metadata {
  discord_message_id?: string
  discord_thread_id?: string
}

process.on('SIGTERM', () => process.exit(0));

(async ({ DISCORD_BOT_TOKEN, OPENAI_API_KEY, OPENAI_ASSISTANT_ID }) => {
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY })
  const assistant_id: string = OPENAI_ASSISTANT_ID!
  client.on(Events.ClientReady, async _client => {
    createServer((_, response) => response.writeHead(204).end()).listen(8080)
  })
  client.on(Events.MessageDelete, async (message) => {
    if (message.author?.bot || message.author?.id === client.user?.id)
      return
    if (message.channel.isThread()) {
      const { assistant_thread_id } = await ThreadRelation.get({ discord_thread_id: message.channelId }) ?? {}
      if (assistant_thread_id) {
        for await (const message of openai.beta.threads.messages.list(assistant_thread_id)) {
          if ((message.metadata as Metadata).discord_message_id) {
            await openai.beta.threads.messages.del(assistant_thread_id, message.id)
            break
          }
        }
      }
    } else if (message.thread) {
      const messageRelation = await ThreadRelation.get({ discord_thread_id: message.thread.id }) ?? {}
      if (messageRelation.assistant_thread_id) {
        await Promise.all([
          messageRelation.delete(),
          openai.beta.threads.del(messageRelation.assistant_thread_id),
        ])
      }
    }
  })
  client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
    if (newMessage.author?.bot || newMessage.author?.id === client.user?.id)
      return
    if (!oldMessage.flags.has(MessageFlagsBitField.Flags.HasThread) && newMessage.flags.has(MessageFlagsBitField.Flags.HasThread))
      return
    const discord_thread_id = newMessage.thread?.id ?? newMessage.channelId
    ok(discord_thread_id)
    /** chappyが作成したthread */
    const { assistant_thread_id } = await ThreadRelation.get({ discord_thread_id }) ?? {}
    if (!assistant_thread_id)
      return
    /** discord: edited message に対応した assistant: message を探す */
    for await (const { id: before, metadata, content } of openai.beta.threads.messages.list(assistant_thread_id, { order: 'asc' })) {
      if ((metadata as Metadata).discord_message_id === newMessage.id) {
        /** 変更点以前の assistant messages を取得 */
        const { data } = await openai.beta.threads.messages.list(assistant_thread_id, { order: 'asc', before })
        const prevMessages = data.map(({ content, role, attachments, metadata }): Threads.ThreadCreateParams.Message => ({
          content: content.map(block => block.type === 'text'
            ? { ...block, text: block.text.value }
            : block
          ),
          role,
          attachments,
          metadata: {
            discord_message_id: (metadata as Metadata).discord_message_id,
            discord_thread_id,
          } as Metadata
        }))
        /**
         * assistant: thread を作り直す
         * `openai.beta.threads.messages.update`: metadata のみ
         * `openai.beta.threads.messages.del`: `role: assistant`な message を削除できない
         */
        const [attachments, imageContents] = await toOpenAIAttachments(openai, newMessage)
        const { id: new_assistant_thread_id } = await openai.beta.threads.create({
          messages: [
            ...prevMessages, {
              role: 'user',
              content: [{
                type: 'text',
                text: toCleanContent(newMessage)
              },
              ...imageContents],
              attachments,
              metadata: {
                discord_message_id: newMessage.id,
                discord_thread_id: discord_thread_id,
              } as Metadata
            }]
        })
        const deleteMessages = newMessage.channel.isThread()
          ? await newMessage.channel.messages.fetch({ after: newMessage.id, cache: false })
          : await newMessage.thread?.messages.fetch({ after: newMessage.id, cache: false }).then(messages => messages.filter(({ system }) => !system))
        if (deleteMessages)
          await Promise.all(deleteMessages.map(message => message.delete()))
        await ThreadRelation.update({ discord_thread_id }, { assistant_thread_id: new_assistant_thread_id })
        await runAssistantAndResponse(openai, assistant_id, new_assistant_thread_id, newMessage)
        break
      }
    }
  })
  client.on(Events.MessageCreate, async message => {
    try {
      if (message.author.bot || message.author.id === client.user?.id)
        return
      if (message.channel.isThread() && message.channel.ownerId === client.user?.id) {
        /** chappyが作成したthread */
        const { assistant_thread_id } = await ThreadRelation.get({ discord_thread_id: message.channelId }) ?? {}
        if (assistant_thread_id) {
          const [attachments, imageContents] = await toOpenAIAttachments(openai, message)
          /**
           * `thread`の状態を管理せず、メッセージの追加を投機実行する:
           * > {"name":"Error","message":"400 Can't add messages to `thread_id` while a run `run_id` is active."}
           * `maxRetries: 10`の場合、最大55.5秒間 = 0.5+1+2+4+8+8*(10-5) 再試行する
           * @see https://github.com/openai/openai-node/blob/d7d5610d91573740d7e3c27e4afde5650ee6e349/src/core.ts#L582
           */
          await openai.beta.threads.messages.create(assistant_thread_id, {
            role: 'user',
            content: [{
              type: 'text',
              text: toCleanContent(message)
            },
            ...imageContents],
            attachments,
            metadata: {
              discord_thread_id: message.thread?.id,
              discord_message_id: message.id,
            } as Metadata
          }, { maxRetries: 10 })
          if (isActivateIntentMessage(message))
            await runAssistantAndResponse(openai, assistant_id, assistant_thread_id, message)
        } else {
          /** thread_idが特定できない場合, chappy以外が作成したthreadの場合 */
          const threadMessages = await message.channel.messages.fetch()
          const messages = await threadMessages.reverse().reduce<Promise<ChatCompletionMessageParam[]>>(async (messages, message) =>
            [...await messages, await getChatCompletionMessage(client, message)], Promise.resolve([]))
          const { object, id, model, choices, usage } = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages,
          })
          console.log(JSON.stringify({ object, id, model, messages, choices, usage }))
          await message.reply({ content: choices.at(0)?.message.content! })
        }
      } else if (message.channel.type === ChannelType.GuildText && isActivateIntentMessage(message)) {
        /** channel -> 新規thread作成 */
        const { id: assistant_thread_id } = await openai.beta.threads.create({
          metadata: {
            discord_message_id: message.id,
            discord_channel_id: message.channel.id,
          }
        })
        const { choices: [{ message: { content: title } }] } = await openai.chat.completions.create({
          model: 'gpt-4-turbo',
          messages: [
            { role: 'system', content: 'You are a helpful assistant. Based on the language of the following initial message, generate a concise and descriptive title for the chat session. If the message is in Japanese, generate the title in Japanese. If the message is in English, generate the title in English.' },
            { role: 'user', content: toCleanContent(message) }
          ],
        })
        const thread = await message.channel.threads.create({ name: title!.slice(0, 50), startMessage: message })
        const [attachments, imageContents] = await toOpenAIAttachments(openai, message)
        await openai.beta.threads.messages.create(assistant_thread_id, {
          role: 'user',
          content: [{
            type: 'text',
            text: toCleanContent(message)
          },
          ...imageContents],
          attachments,
          metadata: {
            discord_message_id: message.id,
            discord_thread_id: thread.id
          } as Metadata
        })
        await Promise.all([
          new ThreadRelation({ discord_thread_id: thread.id, assistant_thread_id }).save(),
          runAssistantAndResponse(openai, assistant_id, assistant_thread_id, message)
        ])
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
