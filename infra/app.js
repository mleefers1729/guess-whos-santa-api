import { App } from 'aws-cdk-lib';
import { SantaStack } from './stack.js';

const app = new App();
new SantaStack(app, 'GuessWhosSanta', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
});
