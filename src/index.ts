import axios from 'axios'
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Attachment,
  type Collection,
  type Message,
  type MessageReplyOptions
} from 'discord.js'
import { createServer } from 'http'
import OpenAI, { toFile } from 'openai'
import { type Threads } from 'openai/resources/beta'
import { type ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { getChatCompletionMessage } from './chat_gpt'

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
})

const uploadFileFromURLtoOpenAI = async (openai: OpenAI, url: string, name?: string) => {
  const { data } = await axios.get(url, { responseType: 'arraybuffer' })
  const { id } = await openai.files.create({ file: await toFile(data, name ?? new URL(url).pathname.split('/').at(-1)), purpose: 'assistants' })
  return id
}
/** @todo fix */
const toOpenAIAttachments = (openai: OpenAI, attachments: Collection<string, Attachment>) =>
  Promise.all(attachments.map(({ url, name }) => uploadFileFromURLtoOpenAI(openai, url, name)))
    .then(file_ids => file_ids.map(file_id => ({ file_id })))
const toDiscordEmbeds = (annotations: Threads.Messages.Annotation[]) =>
  annotations
    .filter((annotation): annotation is Threads.Messages.FileCitationAnnotation => annotation.type === 'file_citation')
    .map(({ text, file_citation: { quote } }) => ({ description: `${text}${quote}` }))
/** `callback`: discord channel/thread に返信する関数。例: `message.reply.bind(message)` */
const runAssistantAndResponse = async (openai: OpenAI, assistant_id: string, thread_id: string, callback: (payload: MessageReplyOptions) => Promise<Message<boolean>>) => {
  /** `status: completed`後にresolve */
  const { object, id, model } = await openai.beta.threads.runs.createAndPoll(thread_id, { assistant_id })
  const { data: [{ content }] } = await openai.beta.threads.messages.list(thread_id, { run_id: id })
  console.log(JSON.stringify({ object, id, model, messages: [content] }))
  const { text: { annotations, value } } = content.find((content): content is Threads.Messages.TextContentBlock => content.type === 'text')!
  for (let len = 0; len < value.length; len += 2000) {
    await callback({ content: value.slice(len, len + 2000), embeds: toDiscordEmbeds(annotations.splice(-Infinity)) })
  }
}
const isActivateIntentMessage = (message: Message) =>
  message.mentions.has(client.user!)
  && !message.mentions.everyone /** @see https://old.discordjs.dev/#/docs/discord.js/main/class/MessageMentions?scrollTo=everyone */
  && !message.author.bot

process.on('SIGTERM', () => process.exit(0));

(async ({ DISCORD_BOT_TOKEN, OPENAI_API_KEY, OPENAI_ASSISTANT_ID }) => {
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY })
  const assistant_id: string = OPENAI_ASSISTANT_ID!
  client.on(Events.ClientReady, async _client => {
    createServer((_, response) => response.writeHead(204).end()).listen(8080)
  })
  client.on(Events.MessageCreate, async message => {
    try {
      if (message.author.bot || message.author.id === client.user?.id)
        return
      if (message.channel.isThread() && message.channel.ownerId === client.user?.id) {
        /** chappyが作成したthreadへの返信 */
        const thread_id = message.channel.name.startsWith('thread_') && message.channel.name
        if (thread_id) {
          const attachments = await toOpenAIAttachments(openai, message.attachments)
          /**
           * `thread`の状態を管理せず、メッセージの追加を投機実行する:
           * > {"name":"Error","message":"400 Can't add messages to `thread_id` while a run `run_id` is active."}
           * `maxRetries: 10`の場合、最大55.5秒間 = 0.5+1+2+4+8+8*(10-5) 再試行する
           * @see https://github.com/openai/openai-node/blob/d7d5610d91573740d7e3c27e4afde5650ee6e349/src/core.ts#L582
           */
          await openai.beta.threads.messages.create(thread_id, {
            role: 'user',
            content: message.cleanContent,
            attachments,
            metadata: {
              discord_thread_id: message.thread?.id,
              discord_message_id: message.id
            }
          }, { maxRetries: 10 })
          if (isActivateIntentMessage(message)) {
            await message.channel.sendTyping()
            await runAssistantAndResponse(openai, assistant_id, thread_id, message.reply.bind(message))
          }
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
        const { id: thread_id } = await openai.beta.threads.create()
        const channelThread = await message.channel.threads.create({ name: thread_id, startMessage: message, autoArchiveDuration: 60 * 24 })
        const attachments = await toOpenAIAttachments(openai, message.attachments)
        await openai.beta.threads.messages.create(thread_id, {
          role: 'user',
          content: message.cleanContent,
          attachments,
          metadata: {
            discord_thread_id: channelThread.id,
            discord_message_id: message.id
          }
        })
        await channelThread.sendTyping()
        await runAssistantAndResponse(openai, assistant_id, thread_id, channelThread.send.bind(channelThread))
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
