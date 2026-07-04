import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

/**
 * Relay's always-on application stack.
 *
 * Cost-guarded moonshot: real managed Postgres (pgvector) + Redis + Fargate
 * behind an ALB, fronted by CloudFront purely to give Slack the https URL it
 * requires (a bare ALB has no TLS cert). natGateways=0 — the Fargate task runs
 * in a public subnet with a public IP so egress to Slack/Anthropic costs no NAT.
 */
export class RelayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    // --- Network: 2 AZ, no NAT (public + isolated tiers) ---
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // --- Application secrets (placeholders; set real values post-deploy) ---
    const secretNames = {
      slackBotToken: 'relay/slack-bot-token',
      slackSigningSecret: 'relay/slack-signing-secret',
      anthropicApiKey: 'relay/anthropic-api-key',
      contactVaultKey: 'relay/contact-vault-key',
    };
    const mkSecret = (logicalId: string, name: string) =>
      new secretsmanager.Secret(this, logicalId, {
        secretName: name,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        secretStringValue: cdk.SecretValue.unsafePlainText('REPLACE_ME'),
      });
    const slackBotToken = mkSecret('SlackBotTokenSecret', secretNames.slackBotToken);
    const slackSigningSecret = mkSecret('SlackSigningSecret', secretNames.slackSigningSecret);
    const anthropicApiKey = mkSecret('AnthropicApiKeySecret', secretNames.anthropicApiKey);
    const contactVaultKey = mkSecret('ContactVaultKeySecret', secretNames.contactVaultKey);

    // --- RDS PostgreSQL 16 (pgvector + pg_trgm ship with RDS; app CREATE EXTENSIONs as master) ---
    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSg', { vpc, description: 'Relay RDS' });
    const db = new rds.DatabaseInstance(this, 'Db', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16_4 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSecurityGroup],
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      databaseName: 'relay',
      credentials: rds.Credentials.fromGeneratedSecret('relay'),
      multiAz: false,
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      backupRetention: cdk.Duration.days(1),
    });
    if (!db.secret) throw new Error('RDS secret was not generated');
    const dbSecret = db.secret;

    // --- ElastiCache Redis (single node) ---
    const redisSecurityGroup = new ec2.SecurityGroup(this, 'RedisSg', { vpc, description: 'Relay Redis' });
    const redisSubnets = new elasticache.CfnSubnetGroup(this, 'RedisSubnets', {
      description: 'Relay Redis isolated subnets',
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
    });
    const redis = new elasticache.CfnCacheCluster(this, 'Redis', {
      engine: 'redis',
      cacheNodeType: 'cache.t4g.micro',
      numCacheNodes: 1,
      cacheSubnetGroupName: redisSubnets.ref,
      vpcSecurityGroupIds: [redisSecurityGroup.securityGroupId],
    });
    redis.addDependency(redisSubnets);
    const redisEndpoint = `redis://${redis.attrRedisEndpointAddress}:${redis.attrRedisEndpointPort}`;

    // --- Fargate service ---
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    const logGroup = new logs.LogGroup(this, 'ServiceLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', { cpu: 256, memoryLimitMiB: 512 });

    // DATABASE_URL is assembled at runtime from the RDS secret via a tiny shell
    // wrapper, because the password/host live in Secrets Manager and must not be
    // baked into the image or the task def in plaintext. config.ts reads DATABASE_URL.
    const container = taskDef.addContainer('relay', {
      image: ecs.ContainerImage.fromAsset('..', { platform: undefined }),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'relay', logGroup }),
      environment: {
        PORT: '3000',
        LOG_LEVEL: 'info',
        REDIS_URL: redisEndpoint,
        PGPORT: '5432',
        PGDATABASE: 'relay',
      },
      secrets: {
        SLACK_BOT_TOKEN: ecs.Secret.fromSecretsManager(slackBotToken),
        SLACK_SIGNING_SECRET: ecs.Secret.fromSecretsManager(slackSigningSecret),
        ANTHROPIC_API_KEY: ecs.Secret.fromSecretsManager(anthropicApiKey),
        CONTACT_VAULT_KEY: ecs.Secret.fromSecretsManager(contactVaultKey),
        PGHOST: ecs.Secret.fromSecretsManager(dbSecret, 'host'),
        PGUSER: ecs.Secret.fromSecretsManager(dbSecret, 'username'),
        PGPASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
        // Full DATABASE_URL is composed in the entrypoint from the PG* vars below.
        DATABASE_URL_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
      },
      // Compose DATABASE_URL from the injected PG* secrets, then exec the app.
      entryPoint: ['/bin/sh', '-c'],
      command: [
        'export DATABASE_URL="postgres://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}"; ' +
          'exec npx tsx src/server.ts',
      ],
      portMappings: [{ containerPort: 3000 }],
    });
    void container;

    const serviceSecurityGroup = new ec2.SecurityGroup(this, 'ServiceSg', { vpc, description: 'Relay Fargate' });
    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [serviceSecurityGroup],
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
      // Fail (and roll back) a deploy in minutes if the task can't reach healthy,
      // instead of ECS retrying for up to 3 hours.
      circuitBreaker: { rollback: true },
    });

    // SG wiring: least privilege.
    dbSecurityGroup.addIngressRule(serviceSecurityGroup, ec2.Port.tcp(5432), 'Fargate -> RDS');
    redisSecurityGroup.addIngressRule(serviceSecurityGroup, ec2.Port.tcp(6379), 'Fargate -> Redis');

    // --- ALB (public HTTP) -> Fargate:3000, health /healthz ---
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', { vpc, internetFacing: true });
    const listener = alb.addListener('Http', { port: 80, open: true });
    const targetGroup = listener.addTargets('Fargate', {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: '/healthz',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
      },
      deregistrationDelay: cdk.Duration.seconds(10),
    });

    // --- CloudFront in front of the ALB: gives Slack the required https URL ---
    // Slack signs the RAW body and sends x-slack-* headers, so caching is off and
    // all viewer headers (except Host) + query strings are forwarded to the origin.
    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: 'Relay — Slack request URL (TLS in front of the ALB)',
      defaultBehavior: {
        origin: new origins.HttpOrigin(alb.loadBalancerDnsName, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          httpPort: 80,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
    });

    // --- Ops: one alarm on unhealthy targets ---
    new cloudwatch.Alarm(this, 'UnhealthyHostsAlarm', {
      metric: targetGroup.metrics.unhealthyHostCount({
        period: cdk.Duration.minutes(1),
        statistic: cloudwatch.Stats.MAXIMUM,
      }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription: 'Relay Fargate has >=1 unhealthy target',
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    // --- Outputs ---
    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'SLACK REQUEST URL host — put this in manifest.prod.yaml (REPLACE_ME_CLOUDFRONT) + /slack/events',
    });
    new cdk.CfnOutput(this, 'HealthCheckUrl', {
      value: `https://${distribution.distributionDomainName}/healthz`,
    });
    new cdk.CfnOutput(this, 'AlbDns', { value: alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'RdsEndpoint', { value: db.dbInstanceEndpointAddress });
    new cdk.CfnOutput(this, 'RdsSecretArn', { value: dbSecret.secretArn, description: 'RDS master credentials' });
    new cdk.CfnOutput(this, 'RedisEndpoint', { value: redisEndpoint });
    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'ServiceName', { value: service.serviceName });
  }
}
