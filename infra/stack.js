import { fileURLToPath } from 'node:url';
import {
  Stack, CfnOutput, CfnParameter, CustomResource, Duration, Fn, RemovalPolicy,
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_cloudwatch as cloudwatch,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_ecr_assets as ecrAssets,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_rds as rds,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
  aws_ses as ses,
  custom_resources as cr,
} from 'aws-cdk-lib';

// Generates the CloudFront signing key pair inside AWS. The private key is written only to
// Secrets Manager; the response carries only the public key. Existing keys are reused on updates.
const SIGNING_KEY_HANDLER = `
const { generateKeyPairSync, createPublicKey } = require('node:crypto');
const sm = new (require('@aws-sdk/client-secrets-manager').SecretsManagerClient)();
const { GetSecretValueCommand, PutSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
exports.handler = async (event) => {
  const secretId = event.ResourceProperties.SecretArn;
  if (event.RequestType === 'Delete') return { PhysicalResourceId: event.PhysicalResourceId };
  const current = (await sm.send(new GetSecretValueCommand({ SecretId: secretId }))).SecretString || '';
  let publicKey;
  if (current.includes('BEGIN PRIVATE KEY')) {
    publicKey = createPublicKey(current).export({ type: 'spki', format: 'pem' });
  } else {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await sm.send(new PutSecretValueCommand({
      SecretId: secretId,
      SecretString: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }));
    publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
  }
  return { PhysicalResourceId: secretId, Data: { PublicKey: publicKey } };
};
`;

export class SantaStack extends Stack {
  get availabilityZones() {
    const zones = Fn.getAzs(this.region);
    return [Fn.select(0, zones), Fn.select(1, zones)];
  }

  constructor(scope, id, props) {
    super(scope, id, props);
    const domain = 'guesswhossanta.com';
    const originDomain = `origin.${domain}`;
    const hostedZoneId = new CfnParameter(this, 'HostedZoneId', {
      description: 'Existing public Route 53 hosted zone for guesswhossanta.com. Delegate the domain to this zone before deployment.',
      allowedPattern: 'Z[A-Z0-9]+',
    });
    const prefixListId = new CfnParameter(this, 'CloudFrontPrefixListId', {
      description: 'us-east-1 managed prefix list ID for com.amazonaws.global.cloudfront.origin-facing.',
      allowedPattern: 'pl-[a-f0-9]+',
    });
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: hostedZoneId.valueAsString, zoneName: domain,
    });
    const signInEmail = new ses.EmailIdentity(this, 'SignInEmail', {
      identity: ses.Identity.publicHostedZone(zone),
    });
    const viewerCertificate = new acm.Certificate(this, 'ViewerCertificate', {
      domainName: domain, validation: acm.CertificateValidation.fromDns(zone),
    });
    const originCertificate = new acm.Certificate(this, 'OriginCertificate', {
      domainName: originDomain, validation: acm.CertificateValidation.fromDns(zone),
    });

    const vpc = new ec2.Vpc(this, 'Network', {
      availabilityZones: this.availabilityZones,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Database', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', { vpc });
    albSecurityGroup.addIngressRule(
      ec2.Peer.prefixList(prefixListId.valueAsString), ec2.Port.tcp(443), 'CloudFront origin-facing only',
    );
    const taskSecurityGroup = new ec2.SecurityGroup(this, 'TaskSecurityGroup', { vpc });
    taskSecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(3000), 'ALB to API only');
    const db = new rds.DatabaseInstance(this, 'Database', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      databaseName: 'santa',
      credentials: rds.Credentials.fromGeneratedSecret('santa'),
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      publiclyAccessible: false,
      multiAz: false,
      backupRetention: Duration.days(7),
      deletionProtection: true,
      removalPolicy: RemovalPolicy.SNAPSHOT,
      cloudwatchLogsExports: ['postgresql'],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_WEEK,
    });
    db.connections.allowFrom(taskSecurityGroup, ec2.Port.tcp(5432), 'API PostgreSQL connections');

    const webBucket = new s3.Bucket(this, 'WebBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const mediaBucket = new s3.Bucket(this, 'MediaBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{
        id: 'ExpireMaskedPhotos',
        prefix: 'media/',
        expiration: Duration.days(30),
        abortIncompleteMultipartUploadAfter: Duration.days(1),
      }],
    });
    const revealBucket = new s3.Bucket(this, 'RevealBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{
        id: 'ExpireRevealPhotos',
        prefix: 'reveals/',
        expiration: Duration.days(30),
        abortIncompleteMultipartUploadAfter: Duration.days(1),
      }],
    });
    const mediaPrivateKey = new secretsmanager.Secret(this, 'MediaSigningKey', {
      description: 'CloudFront photo-URL signing private key (PEM), generated in AWS at deploy time.',
    });
    const signingKeyFunction = new lambda.Function(this, 'SigningKeyFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromInline(SIGNING_KEY_HANDLER),
      timeout: Duration.seconds(30),
    });
    mediaPrivateKey.grantRead(signingKeyFunction);
    mediaPrivateKey.grantWrite(signingKeyFunction);
    const signingKey = new CustomResource(this, 'SigningKey', {
      serviceToken: new cr.Provider(this, 'SigningKeyProvider', {
        onEventHandler: signingKeyFunction,
        logRetention: logs.RetentionDays.ONE_WEEK,
      }).serviceToken,
      properties: { SecretArn: mediaPrivateKey.secretArn },
    });
    const originSecret = new secretsmanager.Secret(this, 'OriginSecret', {
      generateSecretString: {
        secretStringTemplate: '{}', generateStringKey: 'verify',
        passwordLength: 48, excludePunctuation: true,
      },
    });
    const publicKey = new cloudfront.PublicKey(this, 'MediaPublicKey', {
      encodedKey: signingKey.getAttString('PublicKey'),
    });
    const logGroup = new logs.LogGroup(this, 'ApiLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });
    const task = new ecs.FargateTaskDefinition(this, 'ApiTask', {
      // Photo processing (sharp) decodes up to 20 MP images in memory.
      cpu: 256, memoryLimitMiB: 1024,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
      },
    });
    // Optional `-c apiImageTag=<tag>` keeps an already-published API image, e.g. to provision
    // infrastructure without switching the running API.
    const apiImageTag = this.node.tryGetContext('apiImageTag');
    task.addContainer('api', {
      image: apiImageTag
        ? ecs.ContainerImage.fromEcrRepository(
          ecr.Repository.fromRepositoryName(this, 'ApiImageRepository',
            `cdk-hnb659fds-container-assets-${this.account}-${this.region}`),
          apiImageTag,
        )
        : ecs.ContainerImage.fromAsset(
          fileURLToPath(new URL('../', import.meta.url)),
          { platform: ecrAssets.Platform.LINUX_ARM64 },
        ),
      environment: {
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        PORT: '3000',
        CLIENT_ORIGIN: `https://${domain}`,
        DATABASE_HOST: db.dbInstanceEndpointAddress,
        DATABASE_PORT: db.dbInstanceEndpointPort,
        DATABASE_NAME: 'santa',
        DATABASE_CA_FILE: '/app/certs/rds.pem',
        ENABLE_LOCAL_UPLOADS: 'false',
        MEDIA_BUCKET: mediaBucket.bucketName,
        REVEAL_BUCKET: revealBucket.bucketName,
        MEDIA_KEY_PAIR_ID: publicKey.publicKeyId,
        PHOTO_RETENTION_DAYS: '30',
        AWS_REGION: this.region,
        AUTH_EMAIL_FROM: `Guess Who's Santa <signin@${domain}>`,
      },
      secrets: {
        DATABASE_USER: ecs.Secret.fromSecretsManager(db.secret, 'username'),
        DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(db.secret, 'password'),
        ORIGIN_VERIFY_SECRET: ecs.Secret.fromSecretsManager(originSecret, 'verify'),
        MEDIA_PRIVATE_KEY: ecs.Secret.fromSecretsManager(mediaPrivateKey),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'api' }),
      portMappings: [{ containerPort: 3000 }],
      stopTimeout: Duration.seconds(30),
      healthCheck: {
        command: ['CMD-SHELL', 'node -e "fetch(\'http://127.0.0.1:3000/health\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"'],
        interval: Duration.seconds(30), timeout: Duration.seconds(5), retries: 3,
      },
    });
    mediaBucket.grantReadWrite(task.taskRole, 'media/*');
    revealBucket.grantReadWrite(task.taskRole, 'reveals/*');
    task.addToTaskRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail'],
      resources: [signInEmail.emailIdentityArn],
      conditions: { StringEquals: { 'ses:FromAddress': `signin@${domain}` } },
    }));
    const service = new ecs.FargateService(this, 'ApiService', {
      cluster, taskDefinition: task, desiredCount: 2,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [taskSecurityGroup],
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      healthCheckGracePeriod: Duration.seconds(60),
    });
    service.node.addDependency(db, signingKey);
    service.autoScaleTaskCount({ minCapacity: 2, maxCapacity: 6 }).scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 65,
      scaleInCooldown: Duration.minutes(3),
      scaleOutCooldown: Duration.minutes(1),
    });
    const alb = new elbv2.ApplicationLoadBalancer(this, 'ApiAlb', {
      vpc, internetFacing: true, securityGroup: albSecurityGroup,
      dropInvalidHeaderFields: true,
    });
    const listener = alb.addListener('Https', {
      port: 443, certificates: [originCertificate], open: false,
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      defaultAction: elbv2.ListenerAction.fixedResponse(403, {
        contentType: 'application/json', messageBody: '{"error":"Direct API access is not allowed"}',
      }),
    });
    const targetGroup = listener.addTargets('Api', {
      port: 3000, protocol: elbv2.ApplicationProtocol.HTTP, targets: [service],
      priority: 1,
      conditions: [
        elbv2.ListenerCondition.httpHeader('X-Origin-Verify', [
          originSecret.secretValueFromJson('verify').unsafeUnwrap(),
        ]),
      ],
      healthCheck: { path: '/health', healthyHttpCodes: '200', interval: Duration.seconds(30) },
      deregistrationDelay: Duration.seconds(15),
    });
    const originRecord = new route53.ARecord(this, 'OriginDns', {
      zone, recordName: originDomain,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(alb)),
    });

    const keyGroup = new cloudfront.KeyGroup(this, 'MediaKeyGroup', { items: [publicKey] });
    const headers = new cloudfront.ResponseHeadersPolicy(this, 'ResponseHeaders', {
      securityHeadersBehavior: {
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
        contentSecurityPolicy: {
          contentSecurityPolicy: "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests",
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [{ header: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()', override: true }],
      },
    });
    const spaFunction = new cloudfront.Function(this, 'SpaRouting', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromFile({
        filePath: fileURLToPath(new URL('./edge/spa.js', import.meta.url)),
      }),
    });
    const revealHeaders = new cloudfront.ResponseHeadersPolicy(this, 'RevealHeaders', {
      customHeadersBehavior: {
        customHeaders: [{
          header: 'Cache-Control', value: 'private, no-store', override: true,
        }],
      },
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), override: true },
      },
    });
    const apiOrigin = new origins.HttpOrigin(originDomain, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      customHeaders: { 'X-Origin-Verify': originSecret.secretValueFromJson('verify').unsafeUnwrap() },
    });
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      domainNames: [domain],
      certificate: viewerCertificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        functionAssociations: [{
          function: spaFunction, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        }],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: headers,
        },
        '/media/*': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(mediaBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          trustedKeyGroups: [keyGroup],
          cachePolicy: new cloudfront.CachePolicy(this, 'MediaCache', {
            minTtl: Duration.seconds(0), defaultTtl: Duration.minutes(5), maxTtl: Duration.minutes(5),
          }),
          responseHeadersPolicy: headers,
        },
        '/reveals/*': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(revealBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          trustedKeyGroups: [keyGroup],
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          responseHeadersPolicy: revealHeaders,
        },
      },
    });
    distribution.node.addDependency(originRecord);
    const github = new iam.CfnOIDCProvider(this, 'GitHubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIdList: ['sts.amazonaws.com'],
    });
    const deploymentRole = (id, repository) => new iam.Role(this, id, {
      assumedBy: new iam.WebIdentityPrincipal(github.ref, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `repo:mleefers1729/${repository}:ref:refs/heads/main`,
        },
      }),
      maxSessionDuration: Duration.hours(1),
    });
    const frontendDeploy = deploymentRole('GitHubFrontendDeploy', 'guess-whos-santa');
    webBucket.grantRead(frontendDeploy);
    frontendDeploy.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'], resources: [webBucket.arnForObjects('*')],
    }));
    frontendDeploy.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
      resources: [`arn:${this.partition}:cloudfront::${this.account}:distribution/${distribution.distributionId}`],
    }));
    const apiDeploy = deploymentRole('GitHubApiDeploy', 'guess-whos-santa-api');
    for (const role of [frontendDeploy, apiDeploy]) {
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['ses:GetAccount'], resources: ['*'],
      }));
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['ses:GetEmailIdentity'], resources: [signInEmail.emailIdentityArn],
      }));
    }
    apiDeploy.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: ['deploy', 'file-publishing', 'image-publishing', 'lookup'].map((kind) =>
        `arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-${kind}-role-${this.account}-${this.region}`),
    }));
    apiDeploy.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStacks'],
      resources: [this.stackId, `arn:${this.partition}:cloudformation:${this.region}:${this.account}:stack/CDKToolkit/*`],
    }));
    apiDeploy.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:${this.partition}:ssm:${this.region}:${this.account}:parameter/cdk-bootstrap/hnb659fds/version`],
    }));
    new route53.ARecord(this, 'WebDns', {
      zone, recordName: domain,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });
    new route53.AaaaRecord(this, 'WebDnsIpv6', {
      zone, recordName: domain,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });
    new cloudwatch.Alarm(this, 'Api5xxAlarm', {
      metric: targetGroup.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
        period: Duration.minutes(5), statistic: 'Sum',
      }),
      threshold: 10, evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'DatabaseConnectionsAlarm', {
      metric: db.metricDatabaseConnections({ period: Duration.minutes(5) }),
      threshold: 60, evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    for (const [name, value] of Object.entries({
      SiteUrl: `https://${domain}`,
      SignInSender: `signin@${domain}`,
      WebBucketName: webBucket.bucketName,
      MediaBucketName: mediaBucket.bucketName,
      RevealBucketName: revealBucket.bucketName,
      DistributionId: distribution.distributionId,
      MediaKeyPairId: publicKey.publicKeyId,
      ClusterName: cluster.clusterName,
      ServiceName: service.serviceName,
      DatabaseSecretArn: db.secret.secretArn,
      GitHubFrontendDeployRoleArn: frontendDeploy.roleArn,
      GitHubApiDeployRoleArn: apiDeploy.roleArn,
    })) {
      new CfnOutput(this, name, { value });
    }
  }
}
