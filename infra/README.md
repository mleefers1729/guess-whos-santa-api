# Guess Who's Santa: AWS foundation

JavaScript AWS CDK stack for **us-east-1** and **guesswhossanta.com**.
This folder is versioned inside the API repository. CDK builds the Dockerfile
in its parent directory. Keep the stack name `GuessWhosSanta` and construct IDs
unchanged when moving files: those identify the existing production resources.

## What this provisions

- Private, encrypted S3 buckets for web assets, masked media, and a separate
  original-photo reveal store. The unversioned `media/` and `reveals/` prefixes
  both have 30-day lifecycle expiration and incomplete multipart-upload cleanup.
- One CloudFront distribution with ACM TLS and Route 53 apex A/AAAA records.
  - Default: private web bucket through OAC; extensionless SPA routes rewrite to
    `index.html` using a viewer function on this behavior only.
  - `/api/*`: HTTPS-only origin at `origin.guesswhossanta.com`; caching disabled;
    no SPA rewrite and no HTML error fallback.
  - `/media/*`: private media bucket through OAC **and trusted-key signatures**.
    Unsigned requests are forbidden, including guesses of object keys.
  - `/reveals/*`: separate private original-photo bucket through OAC and trusted-key
    signatures, CDN caching disabled and browser `Cache-Control: private, no-store`.
    Original photos are not reachable through the masked-media origin.
- TLS-only ALB: CloudFront managed-prefix-list ingress, secret-header listener
  rule, default `403`, no open HTTP port. Express also validates the header.
- ARM64 ECS Fargate, two small tasks scaling to six, public subnets with no
  direct task ingress except from the ALB, and no NAT gateway charges.
- Private RDS PostgreSQL 17 (`db.t4g.micro`), encrypted GP3, 7-day backups, deletion
  protection and snapshot-on-removal. Secrets Manager holds DB/origin secrets.
- One-week API/DB logs, target 5xx and DB-connection alarms. Alarm notification
  subscriptions and an AWS Budget still need configuring before public launch.
- SES domain identity with Route 53 DKIM records for passwordless sign-in.
  ECS can send only from `signin@guesswhossanta.com` on that identity; no SMTP
  password or email API key is needed. Verification and SES production access
  in **us-east-1** are required before public sign-in works.
- Strict CSP, HSTS, no framing, and camera-only-on-self Permissions-Policy.
  The CSP intentionally permits no advertising/tracking domains yet.

The API creates its own tables at startup, signs photo URLs with a key pair the
stack generates inside AWS (see below), and deletes parties older than 30 days hourly.
After the one-time setup below, successful pushes to `main` deploy automatically.

## Validate locally (no AWS credentials needed)

Node.js 24, npm, and Docker are required.

```sh
npm ci
npm test
npm run synth -- --quiet --lookups false
```

The stack selects the first two available regional zones at CloudFormation
deployment time, uses parameters instead of AWS lookups, and does not create
resources during tests/synthesis.
The tests also exercise the actual CloudFront Function source for deep links,
bare API/media prefixes and missing static assets.

```sh
cd ..
npm ci
npm test
docker build --platform linux/arm64 -t santa-api:local .
```

## First deployment

Deployment creates ongoing AWS charges, including public IPv4s, ALB, ECS, RDS,
Secrets Manager, logs and bandwidth. Review the current AWS calculator and CDK
diff first. The database is single-AZ for launch cost; that is not HA.

For an existing live site, read **Enable sign-in email before opening hosting to
users** below before running the full-stack deployment commands. They also
switch the API to account-required hosting.

1. Reauthenticate with `aws login` if the CLI session has expired. Verify the
   intended account with `aws sts get-caller-identity`.
2. Use an existing Route 53 public hosted zone for `guesswhossanta.com`, or create
   one and delegate the registrar's nameservers to it. Merely reserving a domain
   does not delegate DNS. Record the zone ID. CDK creates certificates and their
   DNS validation records, but does not change registrar nameservers.
3. Find the managed CloudFront origin prefix list ID in **us-east-1**:

   ```sh
   aws ec2 describe-managed-prefix-lists --region us-east-1 \
     --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing \
     --query 'PrefixLists[0].PrefixListId' --output text
   ```

4. Nothing to do for the photo-signing key. On first deploy a one-time Lambda
   generates an RSA 2048 key pair, writes the private key only to the
   `MediaSigningKey` secret (encrypted with the AWS-managed Secrets Manager KMS
   key) and registers the public key with CloudFront. Later deploys reuse it.
   KMS keys cannot be used directly: CloudFront signed URLs require RSA-SHA1,
   which KMS does not support.

5. From this folder, bootstrap the chosen account once:

   ```sh
   npx cdk bootstrap aws://YOUR_ACCOUNT_ID/us-east-1
   npm run diff -- \
     --parameters HostedZoneId=YOUR_ZONE_ID \
     --parameters CloudFrontPrefixListId=YOUR_PREFIX_LIST_ID
   npm run deploy -- \
     --parameters HostedZoneId=YOUR_ZONE_ID \
     --parameters CloudFrontPrefixListId=YOUR_PREFIX_LIST_ID
   ```

   CDK builds/publishes the API image and waits for ECS. DNS/ACM and CloudFront
   can take time. RDS must be available before ECS starts. Keep Docker running.
   The certificates require correct public DNS delegation to finish.

6. Publish the frontend. Replace the two values with the stack's
   `WebBucketName` and `DistributionId` outputs:

   ```sh
   cd ../../guess-whos-santa
   npm ci
   npm run lint
   npm run build
   aws s3 sync dist/assets/ s3://WEB_BUCKET/assets/ \
     --cache-control 'public,max-age=31536000,immutable'
   aws s3 sync dist/ s3://WEB_BUCKET/ --exclude 'assets/*' --exclude index.html \
     --cache-control 'public,max-age=300'
   aws s3 cp dist/index.html s3://WEB_BUCKET/index.html \
     --cache-control 'no-cache,no-store,must-revalidate' --content-type text/html
   aws cloudfront create-invalidation --distribution-id DISTRIBUTION_ID --paths '/*'
   ```

   Retain older hashed assets so in-flight tabs and old cached HTML still work.
   Re-publishing HTML and invalidating are necessary on each web deployment;
   CloudFront's managed web policy has a minimum cache TTL.

7. Check `https://guesswhossanta.com`, an extensionless deep link such as
   `/p/ABCDEF`, and `/api/health` (`database: "connected"`). Confirm that:
   - Unknown API routes return JSON `404`, not HTML.
   - `/api/uploads` returns `404`; the legacy disk upload remains disabled.
   - Unsigned `/media/test.webp` fails with `403`.
   - Unsigned `/reveals/test.webp` fails with `403`.
   - Direct `https://origin.guesswhossanta.com/api/health` is blocked.
   - Play a full party on actual iPhone Safari and Android Chrome: camera,
     share sheet, QR, guessing and face reveal (faces load via signed `/reveals/` URLs).
   - Facebook/Instagram/Messenger allow the file fallback or an external browser.

### Enable sign-in email before opening hosting to users

After deploying the stack, wait for the SES identity's DKIM/domain verification
to complete and request SES production access in **us-east-1**. While in the
SES sandbox, recipient addresses must also be verified. DNS delegation must be
correct for the generated DKIM CNAMEs to verify. Review SES quotas, sender
reputation, bounce/complaint monitoring and email costs before launch.

For an existing live site, do not switch to the new API while SES is restricted:
new party creation requires a verified account, and the previous frontend cannot
create parties against that API. Bootstrap the email identity and deployment
roles without changing the running API first, wait for domain verification and
production access, then coordinate the API/frontend cutover. The full-stack
`npm run deploy` command above also updates the API; it is not an email-only
bootstrap command. Both automated deployments enforce email readiness.

Tables migrate automatically. Existing anonymous party sessions keep working;
users can link them by signing in from the browser that still holds their party
tokens. A lost, previously unlinked host token cannot be recovered using a name
or party code. Keep one canonical site origin so cookies are consistently sent.

Validate with a real recipient after SES is enabled: verify once, create a
party, close/reopen the site and recover it from **Your parties** without another
code. Repeat after clearing local storage (cookies kept), then on another device
using an email code. Sign-out must block further access on the signed-out device.
The cookie lasts 90 idle days, refreshes during use and requires re-verification
after at most one year; account recovery does not extend 30-day photo retention.

## Photo privacy and retention

- Before reveal the API only signs `media/` eye-strip URLs; `reveals/` face URLs
  are signed per object, only for authenticated members after the host reveals.
- Signed URLs last 10–15 minutes. `/reveals/*` disables CDN caching and sends
  `Cache-Control: private, no-store`; `/media/*` caches at most 5 minutes.
- Parties are rejected after 30 days and deleted hourly; S3 lifecycle deletes
  objects asynchronously after 30 days. RDS backups keep metadata for 7 days.
- Already-issued URLs keep working until they expire, and members can always
  screenshot a revealed face.
- Display names stay in the encrypted RDS database (hashing names would not
  protect them and would break the reveal). Player tokens are stored hashed.
- The ECS task has 1 GB memory because sharp decodes images up to 20 MP.

## CI/CD and cleanup

The frontend and API workflows deploy only after checks pass on `main`
(pushes and manual `workflow_dispatch`; never pull requests). Deployment jobs
are serialized, and superseded revisions are skipped. Authentication uses
short-lived GitHub OIDC credentials, not AWS keys stored in GitHub.

The stack provisions a GitHub OIDC provider and two deployment roles. Each
trust policy restricts the audience to `sts.amazonaws.com` and the subject to
one exact repository's immutable owner and repository IDs and `refs/heads/main`.
If either repository is recreated or renamed, update the corresponding trust policy.
Protect `main` in both repositories:
anyone who can change and push its workflows can use that repository's role.
The frontend role can read/write only the web bucket, invalidate this
distribution, and check SES readiness. It cannot access player photos.
The API role can check SES readiness and assume this account/region's existing CDK bootstrap roles;
those roles can deploy infrastructure, so API `main` is a privileged boundary.

Deploy this stack once from an authorized workstation. The workflows default to
the current production stack's values; these **GitHub Actions repository
variables** (Settings > Secrets and variables > Actions > Variables) are only
needed to override them, e.g. after recreating the stack:

| Repository | Variable | Source |
| --- | --- | --- |
| frontend | `AWS_DEPLOY_ROLE_ARN` | `GitHubFrontendDeployRoleArn` |
| frontend | `AWS_WEB_BUCKET` | `WebBucketName` |
| frontend | `AWS_DISTRIBUTION_ID` | `DistributionId` |
| frontend and API | `SITE_URL` | `SiteUrl` |
| API | `AWS_DEPLOY_ROLE_ARN` | `GitHubApiDeployRoleArn` |
| API | `AWS_HOSTED_ZONE_ID` | `HostedZoneId` parameter |
| API | `AWS_CLOUDFRONT_PREFIX_LIST_ID` | `CloudFrontPrefixListId` parameter |

The API workflow installs `infra/`, enables ARM64 builds, and runs CDK deploy
against the existing stack, preserving CloudFormation ownership of ECS task
definitions. The frontend publishes assets first and HTML last, retains old
hashed assets, invalidates CloudFront, waits for completion and compares the
live HTML with the build. Both workflows require a verified SES domain, sending
enabled and SES production access; the frontend also checks the account API.
Failure prevents account-dependent updates from being activated while email is
restricted. After SES approval and initial setup, re-run the workflows or push
again.

To create the SES identity and GitHub roles without switching the running API
(done once for production), pass the live image's container-asset tag:

```sh
npm run deploy -- -c apiImageTag=CURRENT_IMAGE_TAG \
  --parameters HostedZoneId=YOUR_ZONE_ID \
  --parameters CloudFrontPrefixListId=YOUR_PREFIX_LIST_ID
```

For changes spanning both repositories, deploy a backward-compatible API first,
then the frontend. The initial local CDK deployment must happen before the
GitHub roles can be used. To redeploy manually, run `npm run deploy`
from this folder. Never store long-lived AWS keys in GitHub.

RDS deletion protection and retained S3 buckets prevent accidental destruction.
Deleting the stack will not erase photos or stop billing for retained resources.
After deliberate teardown, inspect and remove those specific resources separately.
