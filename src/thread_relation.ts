/**
 * Discord Channel Thread Messages と OpenAI Assistant Thread Messages を関連づける
 */
import { Schema, model } from 'dynamoose'
import { type Item } from 'dynamoose/dist/Item'

export interface IThreadRelation extends Item {
  /** PK: @see https://www.reddit.com/r/discordapp/comments/drtp5s/are_message_ids_universally_unique/?rdt=42527 */
  discord_thread_id: string
  assistant_thread_id?: string
}
export const schema = new Schema({
  discord_thread_id: { type: String, hashKey: true },
  assistant_thread_id: { type: String, required: false },
})
export const tableName = 'thread_relation'
const ThreadRelation = model<IThreadRelation>('ThreadRelation', schema, { tableName, })
export default ThreadRelation
