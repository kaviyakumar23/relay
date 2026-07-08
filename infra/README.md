# Relay Infrastructure (AWS CDK)

> **ARCHIVED — not the live deploy.** AWS is account-restricted for this project,
> so the live host is **Fly.io** (see `docs/DEPLOY.md` + `fly.toml` at the repo
> root). This CDK stack is retained as reference / a portable alternative — it is
> code-complete but not what serves the judging window. Everything below describes
> the AWS path only.

Always-on, cost-guarded AWS hosting for Relay. Infrastructure-as-code so the
hackathon judging window (Jul 14 – Aug 6) has a stable, reproducible target.

```
Internet
  │  https  (Slack requires TLS; a bare ALB has no cert)
  ▼
CloudFront  ── caching disabled, forwards x-slack-* headers + raw body
  │  http
  ▼
ALB (public)  ── health check GET /healthz
  │  :3000
  ▼
ECS Fargate task  (public subnet, public IP — egress needs no NAT)
  ├─▶ RDS PostgreSQL 16 (pgvector, isolated subnet)   :5432
  └─▶ ElastiCache Redis (isolated subnet)             :6379
Secrets Manager: slack-bot-token, slack-signing-secret, anthropic-api-key,
                 contact-vault-key, + RDS master credentials (auto-generated)
```

Two stacks: **RelayStack** (the app) and **RelayCiStack** (GitHub OIDC deploy role).

## Deploy

```bash
cd infra
npm install
npx cdk synth                       # validate — no cloud changes

# One-time per account/region:
npx cdk bootstrap aws://563999587731/ap-south-1

# Provision everything (RDS takes ~10–15 min; builds+pushes the Docker image):
npx cdk deploy RelayStack RelayCiStack --require-approval never
```

Outputs include **CloudFrontUrl** (the Slack request URL host), HealthCheckUrl,
AlbDns, RdsEndpoint, RedisEndpoint, ClusterName, ServiceName, and DeployRoleArn.

## After the first deploy

1. **Set the real secret values** (they deploy as `REPLACE_ME`):
   ```bash
   aws secretsmanager put-secret-value --secret-id relay/slack-bot-token      --secret-string 'xoxb-...'
   aws secretsmanager put-secret-value --secret-id relay/slack-signing-secret --secret-string '...'
   aws secretsmanager put-secret-value --secret-id relay/anthropic-api-key    --secret-string 'sk-ant-...'
   aws secretsmanager put-secret-value --secret-id relay/contact-vault-key    --secret-string "$(openssl rand -hex 32)"
   # then force a new task to pick them up:
   aws ecs update-service --cluster <ClusterName> --service <ServiceName> --force-new-deployment
   ```
2. **Point Slack at CloudFront**: in `manifest.prod.yaml`, replace every
   `REPLACE_ME_CLOUDFRONT` with the CloudFront domain (host only), then update the
   prod Slack app from the manifest. Request URL becomes `https://<domain>/slack/events`.
3. **Run migrations against RDS** (RDS is in an isolated subnet — run from inside
   the VPC). Simplest: a one-off ECS task override running `npm run db:migrate`
   (the app container already has `DATABASE_URL`), or temporarily exec into the
   running task. The migration runs `CREATE EXTENSION vector / pg_trgm` as the
   master user.
4. **CI deploys**: set the GitHub repo variable `AWS_DEPLOY_ROLE_ARN` to the
   `DeployRoleArn` output. Then `.github/workflows/deploy.yml` deploys on push to
   `main` touching `infra/`, `src/`, or `Dockerfile` (OIDC — no stored keys).

## Cost estimate (ap-south-1, on-demand, ~monthly)

| Resource | Spec | Est. USD/mo |
|---|---|---|
| RDS PostgreSQL | db.t4g.micro, 20 GB gp3, single-AZ | ~$13 |
| ElastiCache Redis | cache.t4g.micro, 1 node | ~$12 |
| Fargate | 0.25 vCPU / 0.5 GB, 1 task always-on | ~$9 |
| ALB | 1 load balancer | ~$18 |
| CloudFront | low demo traffic | ~$1 |
| Secrets Manager | 5 secrets | ~$2 |
| CloudWatch | logs (1-wk retention) + 1 alarm | ~$2 |
| **Total** | | **~$55/mo** |

`natGateways: 0` deliberately avoids ~$32/mo+ of NAT. Well within typical AWS
credits for the judging window.

## Teardown

```bash
cd infra
npx cdk destroy RelayStack RelayCiStack
```

All resources use `removalPolicy: DESTROY` (RDS `deletionProtection: false`) so
teardown is clean — appropriate for a hackathon, not for production data.
