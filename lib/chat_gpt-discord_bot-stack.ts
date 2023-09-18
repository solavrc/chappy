import {
  Stack,
  StackProps,
  aws_secretsmanager as secretsmanager,
} from 'aws-cdk-lib'
import { Construct } from 'constructs'

interface ChatGptDiscordBotStackProps extends StackProps {
  secret: secretsmanager.ISecret
}

export class ChatGptDiscordBotStack extends Stack {
  constructor(scope: Construct, id: string, props: ChatGptDiscordBotStackProps) {
    super(scope, id, props)
  }
}
