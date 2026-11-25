import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { SantaStack } from '../stack.js';

const app = new App();
const stack = new SantaStack(app, 'Test', {
  env: { account: '111111111111', region: 'us-east-1' },
});
const template = Template.fromStack(stack);

test('stack synthesis needs no AWS context lookups', () => {
  assert.equal(app.synth().manifest.missing?.length ?? 0, 0);
});

test('database is private, encrypted and protected from deletion', () => {
  template.hasResourceProperties('AWS::RDS::DBInstance', {
    PubliclyAccessible: false, StorageEncrypted: true, DeletionProtection: true, BackupRetentionPeriod: 7,
  });
  template.hasResource('AWS::RDS::DBInstance', {
    DeletionPolicy: 'Snapshot', UpdateReplacePolicy: 'Snapshot',
  });
  template.resourceCountIs('AWS::EC2::NatGateway', 0);
});

test('only masked media prefix is writable and expires after 30 days', () => {
  template.hasResourceProperties('AWS::S3::Bucket', {
    LifecycleConfiguration: {
      Rules: Match.arrayWith([Match.objectLike({ Prefix: 'media/', ExpirationInDays: 30, Status: 'Enabled' })]),
    },
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
    },
  });
});

test('original photos have a separate private encrypted bucket with 30-day expiration', () => {
  template.hasResourceProperties('AWS::S3::Bucket', {
    LifecycleConfiguration: {
      Rules: Match.arrayWith([Match.objectLike({ Prefix: 'reveals/', ExpirationInDays: 30, Status: 'Enabled' })]),
    },
    BucketEncryption: {
      ServerSideEncryptionConfiguration: Match.arrayWith([{
        ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
      }]),
    },
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
    },
  });
  const [distribution] = Object.values(template.findResources('AWS::CloudFront::Distribution'));
  const behaviors = distribution.Properties.DistributionConfig.CacheBehaviors;
  const reveal = behaviors.find((behavior) => behavior.PathPattern === '/reveals/*');
  const media = behaviors.find((behavior) => behavior.PathPattern === '/media/*');
  assert.notEqual(reveal.TargetOriginId, media.TargetOriginId);
  assert.equal(reveal.TrustedKeyGroups.length, 1);
  assert.equal(reveal.CachePolicyId, '4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
  assert.equal(reveal.ViewerProtocolPolicy, 'https-only');
  assert.equal(reveal.FunctionAssociations, undefined);
  const policyId = reveal.ResponseHeadersPolicyId.Ref;
  const policy = template.toJSON().Resources[policyId].Properties.ResponseHeadersPolicyConfig;
  assert.ok(policy.CustomHeadersConfig.Items.some((header) =>
    header.Header === 'Cache-Control' && header.Value === 'private, no-store' && header.Override));
});

test('API never caches, media requires signatures, SPA rewrite is web-only', () => {
  const resources = template.findResources('AWS::CloudFront::Distribution');
  const [distribution] = Object.values(resources);
  const config = distribution.Properties.DistributionConfig;
  assert.equal(config.CustomErrorResponses, undefined);
  assert.equal(config.DefaultCacheBehavior.FunctionAssociations.length, 1);
  const api = config.CacheBehaviors.find((behavior) => behavior.PathPattern === '/api/*');
  assert.equal(api.FunctionAssociations, undefined);
  assert.equal(api.CachePolicyId, '4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
  assert.equal(api.ViewerProtocolPolicy, 'https-only');
  const media = config.CacheBehaviors.find((behavior) => behavior.PathPattern === '/media/*');
  assert.equal(media.TrustedKeyGroups.length, 1);
  assert.equal(media.FunctionAssociations, undefined);
  template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
    OriginAccessControlConfig: Match.objectLike({ SigningBehavior: 'always', SigningProtocol: 'sigv4' }),
  });
});

test('API container disables original uploads and uses ARM64 with verified DB TLS', () => {
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
    ContainerDefinitions: Match.arrayWith([Match.objectLike({
      Environment: Match.arrayWith([
        { Name: 'DATABASE_CA_FILE', Value: '/app/certs/rds.pem' },
        { Name: 'ENABLE_LOCAL_UPLOADS', Value: 'false' },
      ]),
      Secrets: Match.arrayWith([Match.objectLike({ Name: 'MEDIA_PRIVATE_KEY', ValueFrom: { Ref: Match.stringLikeRegexp('^MediaSigningKey') } })]),
    })]),
  });
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
    Protocol: 'HTTPS', Port: 443,
    DefaultActions: Match.arrayWith([Match.objectLike({ Type: 'fixed-response' })]),
  });
});

test('API can sign photo URLs and manage only the photo prefixes', () => {
  const [task] = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
  const env = Object.fromEntries(task.Properties.ContainerDefinitions[0].Environment.map((e) => [e.Name, e.Value]));
  assert.deepEqual(env.MEDIA_KEY_PAIR_ID, { Ref: Object.keys(template.findResources('AWS::CloudFront::PublicKey'))[0] });
  assert.ok(env.REVEAL_BUCKET.Ref);
  assert.equal(task.Properties.Memory, '1024');
  const statements = Object.values(template.findResources('AWS::IAM::Policy'))
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
  const s3Resources = JSON.stringify(statements.filter((statement) =>
    [statement.Action].flat().some((action) => action.startsWith('s3:DeleteObject'))));
  assert.match(s3Resources, /\/media\/\*/);
  assert.match(s3Resources, /\/reveals\/\*/);
});

test('apiImageTag reuses an already-published API image instead of building one', () => {
  const pinnedApp = new App({ context: { apiImageTag: 'abc123' } });
  const pinned = Template.fromStack(new SantaStack(pinnedApp, 'Pinned', {
    env: { account: '111111111111', region: 'us-east-1' },
  }));
  const image = JSON.stringify(pinned.findResources('AWS::ECS::TaskDefinition'));
  assert.match(image, /cdk-hnb659fds-container-assets-111111111111-us-east-1:abc123"/);
});

test('sign-in email verifies the domain and restricts API sending to the approved sender', () => {
  template.hasResourceProperties('AWS::SES::EmailIdentity', { EmailIdentity: 'guesswhossanta.com' });
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([Match.objectLike({
      Environment: Match.arrayWith([{ Name: 'AUTH_EMAIL_FROM', Value: "Guess Who's Santa <signin@guesswhossanta.com>" }]),
    })]),
  });
  const statements = Object.values(template.findResources('AWS::IAM::Policy'))
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
    .filter((statement) => [statement.Action].flat().includes('ses:SendEmail'));
  assert.equal(statements.length, 1);
  assert.notEqual(statements[0].Resource, '*');
  assert.deepEqual(statements[0].Condition, { StringEquals: { 'ses:FromAddress': 'signin@guesswhossanta.com' } });
  const identityId = Object.keys(template.findResources('AWS::SES::EmailIdentity'))[0];
  template.hasResourceProperties('AWS::Route53::RecordSet', {
    Type: 'CNAME', Name: { 'Fn::GetAtt': [identityId, 'DkimDNSTokenName1'] },
    ResourceRecords: [{ 'Fn::GetAtt': [identityId, 'DkimDNSTokenValue1'] }],
  });
});

test('GitHub deployment trusts only the intended repository on main and separates publishing privileges', () => {
  const resources = template.toJSON().Resources;
  const roles = Object.entries(template.findResources('AWS::IAM::Role'));
  const policiesFor = (id) => Object.values(template.findResources('AWS::IAM::Policy'))
    .filter((policy) => policy.Properties.Roles.some((role) => role.Ref === id))
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
  const deployments = roles.filter(([, role]) => role.Properties.AssumeRolePolicyDocument.Statement
    .some((statement) => statement.Action === 'sts:AssumeRoleWithWebIdentity'));
  assert.equal(deployments.length, 2);
  const [providerId, provider] = Object.entries(resources)
    .find(([, resource]) => resource.Type === 'AWS::IAM::OIDCProvider');
  assert.equal(provider.Properties.Url, 'https://token.actions.githubusercontent.com');
  assert.deepEqual(provider.Properties.ClientIdList, ['sts.amazonaws.com']);
  const subjects = new Set();
  for (const [id, role] of deployments) {
    const trust = role.Properties.AssumeRolePolicyDocument.Statement;
    assert.equal(trust.length, 1);
    assert.deepEqual(trust[0].Principal, { Federated: { Ref: providerId } });
    const conditions = trust[0].Condition.StringEquals;
    assert.equal(conditions['token.actions.githubusercontent.com:aud'], 'sts.amazonaws.com');
    const subject = conditions['token.actions.githubusercontent.com:sub'];
    subjects.add(subject);
    const statements = policiesFor(id);
    assert.ok(statements.some((statement) => statement.Action === 'ses:GetAccount' && statement.Resource === '*'));
    const identityRead = statements.find((statement) => statement.Action === 'ses:GetEmailIdentity');
    assert.ok(JSON.stringify(identityRead.Resource).includes('SignInEmail'));
    assert.ok(!statements.some((statement) => [statement.Action].flat().includes('ses:SendEmail')));
    if (subject === 'repo:mleefers1729@55854922/guess-whos-santa@1471782918:ref:refs/heads/main') {
      const s3 = statements.filter((statement) => [statement.Action].flat().some((action) => action.startsWith('s3:')));
      assert.ok(s3.some((statement) => [statement.Action].flat().includes('s3:PutObject')));
      assert.ok(s3.every((statement) => JSON.stringify(statement.Resource).includes('WebBucket')));
      assert.ok(!JSON.stringify(s3).includes('MediaBucket'));
      assert.ok(!JSON.stringify(s3).includes('RevealBucket'));
      assert.ok(!JSON.stringify(statements).includes('sts:AssumeRole'));
      const invalidation = statements.find((statement) => [statement.Action].flat().includes('cloudfront:CreateInvalidation'));
      assert.ok(JSON.stringify(invalidation.Resource).includes('Distribution'));
    } else {
      const assume = statements.find((statement) => statement.Action === 'sts:AssumeRole');
      assert.equal(assume.Resource.length, 4);
      assert.ok(assume.Resource.every((arn) => JSON.stringify(arn).includes('cdk-hnb659fds-')));
      assert.ok(!statements.some((statement) => [statement.Action].flat().includes('s3:PutObject')));
    }
  }
  assert.deepEqual(subjects, new Set([
    'repo:mleefers1729@55854922/guess-whos-santa@1471782918:ref:refs/heads/main',
    'repo:mleefers1729@55854922/guess-whos-santa-api@1471785145:ref:refs/heads/main',
  ]));
});

test('SPA routes work without rewriting API, media, or missing assets into HTML', () => {
  const source = readFileSync(new URL('../edge/spa.js', import.meta.url), 'utf8');
  const rewrite = (uri) => runInNewContext(`${source}; handler(event)`, { event: { request: { uri } } });
  for (const uri of ['/', '/j/ABCDE', '/party/ABCDE', '/party/ABCDE/', '/app-monitor', '/app-monitor/']) {
    assert.equal(rewrite(uri).uri, '/index.html');
  }
  for (const uri of ['/assets/missing.js', '/favicon.svg', '/assets/missing']) {
    assert.equal(rewrite(uri).uri, uri);
  }
  for (const uri of ['/api', '/media', '/reveals']) assert.equal(rewrite(uri).statusCode, 404);
});
