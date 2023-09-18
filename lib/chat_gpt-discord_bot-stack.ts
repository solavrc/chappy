import {
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
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    })
    taskDefinition.addContainer('Container', {
      image: ecs.ContainerImage.fromAsset('./', {
        platform: ecra.Platform.LINUX_ARM64,
      }),
      secrets: {
        DISCORD_BOT_TOKEN: ecs.Secret.fromSecretsManager(props.secret, 'DISCORD_BOT_TOKEN'),
        OPENAI_API_KEY: ecs.Secret.fromSecretsManager(props.secret, 'OPENAI_API_KEY'),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'discord-bot', logGroup: new logs.LogGroup(this, 'LogGroup', { removalPolicy: RemovalPolicy.DESTROY }) }),
    })
    new ecs.FargateService(this, 'Service', {
      assignPublicIp: true,
      circuitBreaker: { rollback: true },
      cluster,
      desiredCount: 1,
      enableExecuteCommand: false,
      maxHealthyPercent: 100,
      minHealthyPercent: 0,
      platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
      taskDefinition,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    })
  }
}
