import { SQS } from "aws-sdk";
import { ChildProcess, spawn } from "child_process";
import { writeFileSync } from "fs";
import { join } from "path";
import Serverless from "serverless";

import { IStacksMap, Stack } from "../types/additional-stack";
import { Provider } from "../types/provider";
import { ServerlessPluginCommand } from "../types/serverless-plugin-command";
import { SQSConfig, SQSLaunchOptions, Stream } from "../types/sqs";

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
      "before:offline:start:init": this.startSQS,
      "before:offline:start:end": this.stopSQS,
    };
  }

  private buildConfig = (
    port = "9234",
    statsPort = "9235",
    region = "us-west-2",
    accountId = "000000000000",
    sqsLimits: "relaxed" | "strict" = "strict",
  ) => {
    return `include classpath("application.conf")

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
  sqs-limits = ${sqsLimits}
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
  accountId = ${accountId}
}
`;
  };

  private spawnSQSProcess = async (options: SQSLaunchOptions) => {
    // We are trying to construct something like this:
    // java -D"config.file=custom.conf" -jar elasticmq-server.jar

    const port = (options.port || 9324).toString();
    const statsPort = (options.statsPort || 9324).toString();

    const SQS_LOCAL_PATH = join(__dirname, "../bin");

    writeFileSync(
      `${SQS_LOCAL_PATH}/custom.conf`,
      this.buildConfig(port, statsPort),
    );

    const args = [];

    if (options.heapInitial != null) {
      args.push(`-Xms${options.heapInitial}`);
    }

    if (options.heapMax != null) {
      args.push(`-Xmx${options.heapMax}`);
    }

    args.push(
      `-D"config.file=${SQS_LOCAL_PATH}/custom.conf"`,
      "-jar",
      "elasticmq-server.jar",
    );

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

    return { proc, port, statsPort };
  };

  private killSQSProcess = (options: SQSLaunchOptions) => {
    const port = (options.port || 9324).toString();
    if (this.sqsInstances[port] != null) {
      this.sqsInstances[port].kill("SIGKILL");
      delete this.sqsInstances[port];
    }
  };

  private startSQS = async () => {
    if (this.sqsConfig.start.noStart) {
      this.serverless.cli.log(
        "SQS Offline - [noStart] options is true. Will not start.",
      );
    } else {
      const { port, proc, statsPort } = await this.spawnSQSProcess(
        this.sqsConfig.start,
      );
      proc.on("close", (code) => {
        this.serverless.cli.log(
          `SQS Offline - Failed to start with code ${code}`,
        );
      });
      this.serverless.cli.log(
        `SQS Offline - Started on port ${port}. Visit: http://localhost:${statsPort} for stats`,
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
