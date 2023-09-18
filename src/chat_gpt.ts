import { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { ChatMessage } from 'gpt-tokenizer/esm/GptEncoding'
import { Client, Message } from 'discord.js'
import { notStrictEqual } from 'assert'
import tokenizer from 'gpt-tokenizer'

export const getChatCompletionMessage = async (client: Client, message: Message<true>): Promise<ChatCompletionMessageParam> => {
  let content = message.cleanContent
  if (!content) {
    const { cleanContent } = await message.fetchReference()
    content = cleanContent
  }
  const role = message.author.id === client.user?.id ? 'assistant' : 'user'
  return { role, content }
}

/** @see https://github.com/niieani/gpt-tokenizer/issues/15 */
export const isWithinTokenLimit = (messages: ChatCompletionMessageParam[], max_input_tokens: number) => {
  const tokens = tokenizer.encodeChat(messages as unknown as ChatMessage[], 'gpt-4').length
  return tokens > max_input_tokens ? false : tokens
}

export const trimMessagesToTokenLimit = ([user, assistant, ...rest]: ChatCompletionMessageParam[], max_input_tokens: number) => {
  const input = rest.at(-1)
  if (!isWithinTokenLimit([user, assistant, input].filter((msg): msg is NonNullable<typeof msg> => msg !== undefined), max_input_tokens)) {
    notStrictEqual(isWithinTokenLimit([input!], max_input_tokens), false)
    return [input!]
  }
  const body = rest.reduceRight<ChatCompletionMessageParam[]>((chunks, chunk) =>
    isWithinTokenLimit([user, assistant, ...chunks, chunk], max_input_tokens) ? [...chunks, chunk] : chunks, []).reverse()
  return [user, assistant, ...body].filter((msg): msg is NonNullable<typeof msg> => msg !== undefined)
}
