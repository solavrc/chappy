import {
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  aws_ec2 as ec2,
  aws_ecr_assets as ecra,
  aws_ecs as ecs,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
} from 'aws-cdk-lib'
import { Construct } from 'constructs'

interface ChatGptDiscordBotStackProps extends StackProps {
  secret: secretsmanager.ISecret
}

export class ChatGptDiscordBotStack extends Stack {
  constructor(scope: Construct, id: string, props: ChatGptDiscordBotStackProps) {
    super(scope, id, props)

    const vpc = new ec2.Vpc(this, 'Vpc', {
      subnetConfiguration: [{
        name: 'Public',
        subnetType: ec2.SubnetType.PUBLIC,
        cidrMask: 20,
      }, {
        name: 'Isolated',
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        cidrMask: 20,
      }],
      maxAzs: 1,
      natGateways: 0,
    })

    const cluster = new ecs.Cluster(this, 'Cluster', { vpc })
    const taskDefinition = new ecs.TaskDefinition(this, 'TaskDefinition', {
      compatibility: ecs.Compatibility.FARGATE,
      cpu: '256',
      memoryMiB: '512',
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    })
    taskDefinition.addContainer('Container', {
      image: ecs.ContainerImage.fromAsset('./', {
        platform: ecra.Platform.LINUX_AMD64,
      }),
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:8080/ || exit 1'], /** @see Dockerfile */
        interval: Duration.seconds(5),
        retries: 2,
        startPeriod: Duration.seconds(0),
        timeout: Duration.seconds(2)
      },
      portMappings: [{ containerPort: 8080 }],
      secrets: {
        DISCORD_BOT_TOKEN: ecs.Secret.fromSecretsManager(props.secret, 'DISCORD_BOT_TOKEN'),
        OPENAI_API_KEY: ecs.Secret.fromSecretsManager(props.secret, 'OPENAI_API_KEY'),
        OPENAI_ASSISTANT_ID: ecs.Secret.fromSecretsManager(props.secret, 'OPENAI_ASSISTANT_ID'),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: this.stackName }),
    })
    new ecs.FargateService(this, 'Service', {
      assignPublicIp: true,
      circuitBreaker: { rollback: true },
      cluster,
      desiredCount: 1,
      enableExecuteCommand: false,
      maxHealthyPercent: 200,
      minHealthyPercent: 100,
      platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
      taskDefinition,
    })
  }
}
