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
    # TODO: Implement this
    # If you only want to use SQS Offline in some stages, declare them here
    stages:
      - dev
    start:
      # Here you cane use all of the command line options described at
      # https://docs.aws.amazon.com/amazonSQS/latest/developerguide/SQSLocal.UsageNotes.html
      cors: "*" # Enables support for cross-origin resource sharing (CORS) for JavaScript. You must provide a comma-separated "allow" list of specific domains. The default setting for [cors] is an asterisk (*), which allows public access.
      dbPath: "/tmp" # The directory where SQS writes its database file. If you don't specify this option, the file is written to the current directory. You can't specify both [dbPath] and [inMemory] at once.
      delayTransientStatuses: true # Causes SQS to introduce delays for certain operations. SQS (Downloadable Version) can perform some tasks almost instantaneously, such as create/update/delete operations on tables and indexes. However, the SQS service requires more time for these tasks. Setting this parameter helps SQS running on your computer simulate the behavior of the SQS web service more closely. (Currently, this parameter introduces delays only for global secondary indexes that are in either CREATING or DELETING status.)
      inMemory: true # SQS runs in memory instead of using a database file. When you stop SQS, none of the data is saved. You can't specify both [dbPath] and [inMemory] at once.
      optimizeDbBeforeStartup: true # Optimizes the underlying database tables before starting SQS on your computer. You also must specify [dbPath] when you use this parameter.
      host: localhost # The host that SQS uses to communicate with your application. If you don't specify this option, the default host is localhost
      port: 8000 # The port number that SQS uses to communicate with your application. If you don't specify this option, the default port is 8000. If port 8000 is unavailable, this command throws an exception. You can use the port option to specify a different port number
      sharedDb: true # If you specify [sharedDb], SQS uses a single database file instead of separate files for each credential and Region.

      # Some java -Xms arguments can also be provided as configs
      heapInitial: "2048m" # Initial heap size for [java -Xms] arguments
      heapMax: "1g" # Maximum heap size for [java -Xmx] arguments

      # The plugin itself has a few helpful configuration options
      migrate: true # After starting SQS local, create SQS tables from the current serverless configuration.
      noStart: false # Does not start the SQS. This option is useful if you already have a running instance of SQS locally
```
