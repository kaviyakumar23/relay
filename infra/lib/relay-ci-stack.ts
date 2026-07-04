import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export interface RelayCiStackProps extends cdk.StackProps {
  githubOwner: string;
  githubRepo: string;
}

/**
 * GitHub Actions OIDC deploy role. The workflow assumes this role (no long-lived
 * keys) and runs `cdk deploy`, which itself assumes the CDK bootstrap roles — so
 * this role only needs sts:AssumeRole on the account's cdk-* roles.
 */
export class RelayCiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RelayCiStackProps) {
    super(scope, id, props);

    // Create the GitHub OIDC provider (this account has only Vercel providers today).
    const provider = new iam.OpenIdConnectProvider(this, 'GithubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    const sub = `repo:${props.githubOwner}/${props.githubRepo}:ref:refs/heads/main`;
    const deployRole = new iam.Role(this, 'DeployRole', {
      roleName: 'relay-github-deploy',
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: { 'token.actions.githubusercontent.com:sub': sub },
      }),
      description: 'Assumed by GitHub Actions to run cdk deploy for Relay',
      maxSessionDuration: cdk.Duration.hours(1),
    });

    // cdk deploy works by assuming the bootstrap roles; that is all this role needs.
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
      }),
    );

    new cdk.CfnOutput(this, 'DeployRoleArn', {
      value: deployRole.roleArn,
      description: 'Set as GitHub repo variable AWS_DEPLOY_ROLE_ARN (used by .github/workflows/deploy.yml)',
    });
  }
}
