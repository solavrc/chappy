import { Construct } from 'constructs'
import {
  RemovalPolicy,
  Stack,
  StackProps,
  aws_secretsmanager as secretsmanager,
} from 'aws-cdk-lib'
export class ChatGptDiscordBotSecretStack extends Stack {
  readonly secret: secretsmanager.Secret
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    this.secret = new secretsmanager.Secret(this, 'Secret', {
      generateSecretString: {
        generateStringKey: 'DUMMY_KEY',
        secretStringTemplate: JSON.stringify({
          DISCORD_BOT_TOKEN: undefined,
          OPENAI_API_KEY: undefined,
          OPENAI_ASSISTANT_ID: undefined,
        }),
      },
      removalPolicy: RemovalPolicy.DESTROY
    })
  }
}
