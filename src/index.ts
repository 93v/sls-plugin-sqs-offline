import { SQS, Lambda } from "aws-sdk/clients/all";
import { ClientConfiguration } from "aws-sdk/clients/lambda";
import { ChildProcess, spawn } from "child_process";
import { join } from "path";
import Serverless from "serverless";

import { IStacksMap, Stack } from "../types/additional-stack";
import { SQSConfig, SQSLaunchOptions, Stream } from "../types/sqs";
import { Provider } from "../types/provider";
import { ServerlessPluginCommand } from "../types/serverless-plugin-command";
import { writeFileSync } from "fs";

const getConfig = (
  port: string = "9234",
  statsPort = "9235",
  region = "us-west-2",
) => {
  return `
include classpath("application.conf")

# What is the outside visible address of this ElasticMQ node
# Used to create the queue URL (may be different from bind address!)
node-address {
  protocol = http
  host = localhost
  port = ${port}
  context-path = ""
}

rest-sqs {
  enabled = true
  bind-port = ${port}
  bind-hostname = "0.0.0.0"
  # Possible values: relaxed, strict
  sqs-limits = strict
}

rest-stats {
  enabled = true
  bind-port = ${statsPort}
  bind-hostname = "0.0.0.0"
}

# Should the node-address be generated from the bind port/hostname
# Set this to true e.g. when assigning port automatically by using port 0.
generate-node-address = false

queues {
  # See next sections
}

queues-storage {
  # See next sections
}

# Region and accountId which will be included in resource ids
aws {
  region = ${region}
  accountId = 000000000000
}
`;
};

const SQS_LOCAL_PATH = join(__dirname, "../bin");

const DEFAULT_READ_INTERVAL = 500;

const pause = async (duration: number) =>
  new Promise((r) => setTimeout(r, duration));

class ServerlessSQSOfflinePlugin {
  public readonly commands: Record<string, ServerlessPluginCommand>;
  public readonly hooks: Record<string, () => Promise<any>>;
  public provider: Provider;
  private additionalStacksMap: IStacksMap;
  private defaultStack: Stack;
  private sqsConfig: SQSConfig;
  private sqsClient?: SQS;
  private sqsInstances: Record<string, ChildProcess> = {};

  public constructor(private serverless: Serverless) {
    this.provider = this.serverless.getProvider("aws");

    this.commands = {};

    this.sqsConfig = this.serverless.service?.custom?.sqs || {};

    this.additionalStacksMap =
      this.serverless.service?.custom?.additionalStacks || {};

    this.defaultStack = (
      (this.serverless.service || {}) as unknown as {
        resources: any;
      }
    ).resources;

    this.hooks = {
      "before:offline:start:end": this.stopSQS,
      "before:offline:start:init": this.startSQS,
    };
  }

  private spawnSQSProcess = async (options: SQSLaunchOptions) => {
    // We are trying to construct something like this:
    // java -D"config.file=custom.conf" -jar elasticmq-server.jar

    const port = (options.port || 9324).toString();

    writeFileSync(`${SQS_LOCAL_PATH}/custom.conf`, getConfig(port));

    const args = [];

    if (options.heapInitial != null) {
      args.push(`-Xms${options.heapInitial}`);
    }

    if (options.heapMax != null) {
      args.push(`-Xmx${options.heapMax}`);
    }

    args.push(
      `-D"jconfig.file=${SQS_LOCAL_PATH}/custom.conf"`,
      "-jar",
      "elasticmq-server.jar",
    );

    // if (options.cors != null) {
    //   args.push("-cors", options.cors);
    // }

    // if (options.sqsPath != null) {
    //   args.push("-sqsPath", options.sqsPath);
    // } else {
    //   args.push("-inMemory");
    // }

    // if (options.delayTransientStatuses) {
    //   args.push("-delayTransientStatuses");
    // }

    // if (options.optimizeDbBeforeStartup) {
    //   args.push("-optimizeDbBeforeStartup");
    // }

    // if (port != null) {
    //   args.push("-port", port.toString());
    // }

    // if (options.sharedDb) {
    //   args.push("-sharedDb");
    // }

    const proc = spawn("java", args, {
      cwd: SQS_LOCAL_PATH,
      env: process.env,
      stdio: ["pipe", "pipe", process.stderr],
    });

    if (proc.pid == null) {
      throw new Error("Unable to start the SQS Local process");
    }

    proc.on("error", (error) => {
      throw error;
    });

    this.sqsInstances[port] = proc;

    (
      [
        "beforeExit",
        "exit",
        "SIGINT",
        "SIGTERM",
        "SIGUSR1",
        "SIGUSR2",
        "uncaughtException",
      ] as unknown as NodeJS.Signals[]
    ).forEach((eventType) => {
      process.on(eventType, () => {
        this.killSQSProcess(this.sqsConfig.start);
      });
    });

    return { proc, port };
  };

  private killSQSProcess = (options: SQSLaunchOptions) => {
    const port = (options.port || 9324).toString();

    if (this.sqsInstances[port] != null) {
      this.sqsInstances[port].kill("SIGKILL");
      delete this.sqsInstances[port];
    }
  };

  // private createDBStreamReadable = async (
  //   functionName: string,
  //   stream: Stream,
  // ) => {
  //   this.serverless.cli.log(
  //     `Create stream for ${functionName} on ${stream.tableName}`,
  //   );

  //   const tableDescription = await this.sqsClient
  //     ?.describeTable({ TableName: stream.tableName })
  //     .promise();

  //   const streamArn = tableDescription?.Table?.LatestStreamArn;

  //   if (streamArn == null) {
  //     return;
  //   }

  //   // Do not await to not block the rest of the serverless offline execution
  //   Promise.allSettled(
  //     streamDescription.StreamDescription.Shards.map(async (shard) => {
  //       if (shard.ShardId == null) {
  //         return;
  //       }

  //       if (this.dbStreamsClient == null) {
  //         return;
  //       }

  //       const shardIteratorType = stream.startingPosition || "TRIM_HORIZON";

  //       const getIteratorParams: GetShardIteratorInput = {
  //         ShardId: shard.ShardId,
  //         StreamArn: streamArn,
  //         ShardIteratorType: shardIteratorType,
  //       };

  //       if (this.sqsConfig.stream?.iterator) {
  //         getIteratorParams.ShardIteratorType = this.sqsConfig.stream?.iterator;
  //       } else if (this.sqsConfig.stream?.startAt) {
  //         getIteratorParams.ShardIteratorType = "AT_SEQUENCE_NUMBER";
  //         getIteratorParams.SequenceNumber = this.sqsConfig.stream?.startAt;
  //       } else if (this.sqsConfig.stream?.startAfter) {
  //         getIteratorParams.ShardIteratorType = "AFTER_SEQUENCE_NUMBER";
  //         getIteratorParams.SequenceNumber = this.sqsConfig.stream?.startAfter;
  //       } else {
  //         getIteratorParams.ShardIteratorType = "LATEST";
  //       }

  //       const iterator = await this.dbStreamsClient
  //         .getShardIterator(getIteratorParams)
  //         .promise();

  //       if (iterator.ShardIterator == null) {
  //         return;
  //       }

  //       let shardIterator = iterator.ShardIterator;

  //       // eslint-disable-next-line no-constant-condition
  //       while (true) {
  //         const getRecordsParams: GetRecordsInput = {
  //           ShardIterator: shardIterator,
  //           Limit: stream.batchSize || 20,
  //         };

  //         const records = await this.dbStreamsClient
  //           .getRecords(getRecordsParams)
  //           .promise();

  //         if (records.NextShardIterator != null) {
  //           shardIterator = records.NextShardIterator;
  //         }

  //         if (records.Records != null && records.Records.length) {
  //           const lambdaParams: ClientConfiguration = {
  //             endpoint: `http://localhost:${
  //               this.serverless.service.custom["serverless-offline"]
  //                 .lambdaPort || 3002
  //             }`,
  //             region: this.sqsConfig.start.region || "local",
  //           };

  //           const lambda = new Lambda(lambdaParams);

  //           const params = {
  //             FunctionName: `${this.serverless.service["service"]}-${this.serverless.service.provider.stage}-${functionName}`,
  //             InvocationType: "Event",
  //             Payload: JSON.stringify(records),
  //           };

  //           await lambda.invoke(params).promise();
  //         }

  //         await pause(
  //           this.sqsConfig.stream?.readInterval || DEFAULT_READ_INTERVAL,
  //         );
  //       }
  //     }),
  //   ).then((r) => {
  //     this.serverless.cli.log(r.length.toString());
  //   });
  // };

  private startSQS = async () => {
    if (this.sqsConfig.start.noStart) {
      this.serverless.cli.log(
        "SQS Offline - [noStart] options is true. Will not start.",
      );
    } else {
      const { port, proc } = await this.spawnSQSProcess(this.sqsConfig.start);

      proc.on("close", (code) => {
        this.serverless.cli.log(
          `SQS Offline - Failed to start with code ${code}`,
        );
      });

      this.serverless.cli.log(
        `SQS Offline - Started, visit: http://localhost:${port}/shell`,
      );
    }

    if (!this.sqsConfig.start.migrate) {
      this.serverless.cli.log(
        "SQS Offline - [migrate] options is not true. Will not create queues.",
      );
      return;
    }

    const clientConfig: SQS.ClientConfiguration = {
      accessKeyId: this.sqsConfig.start.accessKeyId || "localAwsAccessKeyId",
      endpoint: `http://${this.sqsConfig.start.host || "localhost"}:${
        this.sqsConfig.start.port
      }`,
      region: this.sqsConfig.start.region || "local",
      secretAccessKey:
        this.sqsConfig.start.secretAccessKey || "localAwsSecretAccessKey",
    };

    this.serverless.cli.log(JSON.stringify(clientConfig, null, 2));

    this.sqsClient = new SQS(clientConfig);

    const queues: any[] = [];
    Object.values({
      ...this.additionalStacksMap,
      ...{ [Symbol(Date.now()).toString()]: this.defaultStack },
    }).forEach((stack) => {
      if (stack == null) {
        return;
      }
      Object.values(stack.Resources).forEach((resource: any) => {
        if (resource.Type === "AWS::SQS::Queue") {
          queues.push(resource);
        }
      });
    });

    if (queues.length === 0) {
      return;
    }

    // TODO: Create dead letter queues first

    await Promise.all(
      queues.map(async (queue) => {
        if (this.sqsClient == null) {
          return;
        }
        return this.createQueue(this.sqsClient, queue);
      }),
    );

    await Promise.all(
      this.serverless.service.getAllFunctions().map(async (functionName) => {
        const events = this.serverless.service.getFunction(functionName).events;

        await Promise.all(
          events.map(async (event) => {
            const stream: null | Stream = event["stream"];

            if (stream == null || !stream.enabled || stream.type !== "sqs") {
              return;
            }

            // return this.createDBStreamReadable(functionName, stream);
          }),
        );
      }),
    );
  };

  private stopSQS = async () => {
    this.killSQSProcess(this.sqsConfig.start);
    this.serverless.cli.log("SQS Offline - Stopped");
  };

  private createQueue = async (sqsClient: SQS, queue: any) => {
    const params: SQS.CreateQueueRequest = queue.Properties;

    try {
      await sqsClient.createQueue(params).promise();
      this.serverless.cli.log(
        `SQS Offline - Queue [${params.QueueName}] created`,
      );
    } catch (error) {
      if ((error as any).code === "ResourceInUseException") {
        this.serverless.cli.log(
          `SQS Offline - Queue [${params.QueueName}] already exists`,
        );
      } else {
        throw error;
      }
    }
  };
}

export = ServerlessSQSOfflinePlugin;
