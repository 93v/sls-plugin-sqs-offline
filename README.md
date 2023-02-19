# sls-plugin-sqs-offline

![David](https://img.shields.io/david/93v/sls-plugin-sqs-offline.svg)
![GitHub code size in bytes](https://img.shields.io/github/languages/code-size/93v/sls-plugin-sqs-offline.svg)
![GitHub repo size](https://img.shields.io/github/repo-size/93v/sls-plugin-sqs-offline.svg)
![npm](https://img.shields.io/npm/dw/sls-plugin-sqs-offline.svg)
![npm](https://img.shields.io/npm/dm/sls-plugin-sqs-offline.svg)
![npm](https://img.shields.io/npm/dy/sls-plugin-sqs-offline.svg)
![npm](https://img.shields.io/npm/dt/sls-plugin-sqs-offline.svg)
![NPM](https://img.shields.io/npm/l/sls-plugin-sqs-offline.svg)
![npm](https://img.shields.io/npm/v/sls-plugin-sqs-offline.svg)
![GitHub last commit](https://img.shields.io/github/last-commit/93v/sls-plugin-sqs-offline.svg)
![npm collaborators](https://img.shields.io/npm/collaborators/sls-plugin-sqs-offline.svg)

Serverless Framework Plugin to Work with AWS SQS Offline

## Installation

To install with npm, run this in your service directory:

```bash
npm install --save-dev sls-plugin-sqs-offline
```

Then add this to your `serverless.yml`

```yml
plugins:
  - sls-plugin-sqs-offline
```

> Important:
> To run SQS on your computer, you must have the Java Runtime Environment
> (JRE) version 6.x or newer. The application doesn't run on earlier JRE versions.

## How it works

The plugin downloads the official SQS (Downloadable Version) on Your
Computer and allows the serverless app to launch it with the full set of
supported configurations

## Configuration

To configure SQS Offline, add a `sqs` section like this to your
`serverless.yml`:

```yml
custom:
  sqs:
    start:
      noStart: false # If true will not start SQS
      autoCreate: true # Create queues after startup
      port: 9234 # The port number that SQS uses to communicate with your application. If you don't specify this option, the default port is 9234. If port 9234 is unavailable, this command throws an exception. You can use the port option to specify a different port number
      statsPort: 9235 # The port number that SQS uses to host statistics UI. If you don't specify this option, the default port is 9235. If port 9235 is unavailable, this command throws an exception. You can use the statsPort option to specify a different port number
      host: "127.0.0.1" # The hostname that SQS uses to communicate with your application. If you don't specify this option, the default hostname is "127.0.0.1".
      region: "local" # The region that SQS is mocked to run in. If you don't specify this option, the default region is "local".
      accountId: "000000000000" # The AWS account ID that you want to use when mocking the SQS service. If you don't specify this option, the default account ID is "000000000000".
      accessKeyId: "localAwsAccessKeyId" # The AWS access key ID that you want to use when mocking the SQS service. If you don't specify this option, the default access key ID is "localAwsAccessKeyId".
      secretAccessKey: "localAwsSecretAccessKey" # The AWS secret access key that you want to use when mocking the SQS service. If you don't specify this option, the default secret access key is "localAwsSecretAccessKey".
    stream:
      readInterval: 500 # The interval, in milliseconds, that the application reads messages from the queue. If you don't specify this option, the default value is 500.
```

## Recommended configuration

The configuration below is the minimal recommended configuration.

```yml
custom:
  sqs:
    start:
      autoCreate: true
      port: 9234
    stream:
      readInterval: 1000
```
