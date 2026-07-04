#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RelayCiStack } from '../lib/relay-ci-stack';
import { RelayStack } from '../lib/relay-stack';

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT ?? '563999587731',
  region: process.env.CDK_DEFAULT_REGION ?? 'ap-south-1',
};

// The always-on application: VPC, RDS, Redis, Fargate behind ALB + CloudFront (TLS for Slack).
new RelayStack(app, 'RelayStack', {
  env,
  description: 'Relay — crisis coordination Slack agent: Fargate + RDS(pgvector) + Redis + ALB + CloudFront',
});

// GitHub Actions OIDC deploy role (separate lifecycle from the app).
new RelayCiStack(app, 'RelayCiStack', {
  env,
  githubOwner: 'indrapranesh',
  githubRepo: 'relay-crisis',
  description: 'Relay — GitHub OIDC role for CI deploys',
});

app.synth();
