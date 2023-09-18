#!/usr/bin/env node
import 'source-map-support/register'
import { App, Environment } from 'aws-cdk-lib'
import { ChatGptDiscordBotSecretStack } from '../lib/chat_gpt-discord_bot-secret-stack'
import { ChatGptDiscordBotStack } from '../lib/chat_gpt-discord_bot-stack'

const env: Environment = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }
const app = new App()

const chatGptDiscordBotSecretStack = new ChatGptDiscordBotSecretStack(app, 'ChatGptDiscordBotSecretStack', { env })
const { secret } = chatGptDiscordBotSecretStack
new ChatGptDiscordBotStack(app, 'ChatGptDiscordBotStack', { env, secret }).addDependency(chatGptDiscordBotSecretStack)
