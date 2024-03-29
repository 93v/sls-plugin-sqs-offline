import { Lambda, SQS } from "aws-sdk";
import { ClientConfiguration } from "aws-sdk/clients/lambda";
import { ChildProcess, spawn } from "child_process";
import { writeFileSync } from "fs";
import { join } from "path";
import Serverless from "serverless";
import { waitUntilUsedOnHost } from "tcp-port-used";
import { setTimeout } from "timers/promises";

import { IStacksMap, Stack } from "../types/additional-stack";
import { Provider } from "../types/provider";
import { ServerlessPluginCommand } from "../types/serverless-plugin-command";
import { Queue, SQSConfig, SQSLaunchOptions } from "../types/sqs";

const DEFAULT_PORT = "9234";
const DEFAULT_STATS_PORT = "9235";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_REGION = "local";
const DEFAULT_ACCOUNT = "000000000000";
const DEFAULT_READ_INTERVAL = 500;

class ServerlessSQSOfflinePlugin {
  public readonly commands: Record<string, ServerlessPluginCommand>;
  public readonly hooks: Record<string, () => Promise<any>>;
  public provider: Provider;
  private additionalStacksMap: IStacksMap;
  private defaultStack: Stack;
  private sqsConfig: SQSConfig;
  private sqsClient?: SQS;
  private sqsInstances: Record<string, ChildProcess> = {};
  private readonly log: (message: string) => void;

  public constructor(
    private serverless: Serverless,
    _options: any,
    { log }: { log: (message: string) => void },
  ) {
    this.provider = this.serverless.getProvider("aws");
    this.log = log;

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
    port = DEFAULT_PORT,
    statsPort = DEFAULT_STATS_PORT,
    host = DEFAULT_HOST,
    region = DEFAULT_REGION,
    accountId = DEFAULT_ACCOUNT,
    sqsLimits: "relaxed" | "strict" = "strict",
  ) => {
    return `include classpath("application.conf")

# What is the outside visible address of this ElasticMQ node
# Used to create the queue URL (may be different from bind address!)
node-address {
  protocol = http
  host = ${host}
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
    // java -D"config.file=local.conf" -jar elasticmq-server.jar

    const port = (options.port || DEFAULT_PORT).toString();
    const statsPort = (options.statsPort || DEFAULT_STATS_PORT).toString();
    const host = (options.host || DEFAULT_HOST).toString();

    const SQS_LOCAL_PATH = join(__dirname, "../bin");

    writeFileSync(
      `${SQS_LOCAL_PATH}/local.conf`,
      this.buildConfig(port, statsPort, host),
    );

    const args = [];

    if (options.heapInitial != null) {
      args.push(`-Xms${options.heapInitial}`);
    }

    if (options.heapMax != null) {
      args.push(`-Xmx${options.heapMax}`);
    }

    args.push(`-D"config.file=local.conf"`, "-jar", "elasticmq-server.jar");

    const proc = spawn("java", args, {
      cwd: SQS_LOCAL_PATH,
      env: process.env,
      stdio: ["pipe", "pipe", process.stderr],
      shell: true,
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

    return { proc, port, statsPort, host };
  };

  private killSQSProcess = (options: SQSLaunchOptions) => {
    const port = (options.port || DEFAULT_PORT).toString();
    if (this.sqsInstances[port] != null) {
      this.sqsInstances[port].kill("SIGKILL");
      delete this.sqsInstances[port];
    }
  };

  private createSQSStreamReadable = async (functionName: string, q: Queue) => {
    if (!q.queueName) {
      return;
    }

    this.log(`Create stream for ${functionName} on ${q.queueName}`);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const queueUrl = await this.sqsClient
        ?.getQueueUrl({
          QueueName: q.queueName,
        })
        .promise();

      if (queueUrl?.QueueUrl) {
        const messages = await this.sqsClient
          ?.receiveMessage({
            QueueUrl: queueUrl.QueueUrl,
            MaxNumberOfMessages: q.batchSize ? Math.min(10, q.batchSize) : 1,
          })
          .promise();

        interface SQSRecordAttributes {
          AWSTraceHeader?: string;
          ApproximateReceiveCount: string;
          SentTimestamp: string;
          SenderId: string;
          ApproximateFirstReceiveTimestamp: string;
          SequenceNumber?: string;
          MessageGroupId?: string;
          MessageDeduplicationId?: string;
        }

        interface SQSMessageAttributes {
          [name: string]: SQSMessageAttribute;
        }

        interface SQSMessageAttribute {
          stringValue?: string;
          binaryValue?: string;
          stringListValues: never[]; // Not implemented. Reserved for future use.
          binaryListValues: never[]; // Not implemented. Reserved for future use.
          dataType: SQSMessageAttributeDataType;
        }

        type SQSMessageAttributeDataType =
          | "String"
          | "Number"
          | "Binary"
          | string;

        interface SQSRecord {
          messageId: string;
          receiptHandle: string;
          body: string;
          attributes: SQSRecordAttributes;
          messageAttributes: SQSMessageAttributes;
          md5OfBody: string;
          eventSource: string;
          eventSourceARN: string;
          awsRegion: string;
        }

        interface SQSEvent {
          Records: SQSRecord[];
        }

        if (messages?.Messages) {
          const lambdaParams: ClientConfiguration = {
            endpoint: `http://${
              this.serverless.service.custom["serverless-offline"].host ||
              "127.0.0.1"
            }:${
              this.serverless.service.custom["serverless-offline"].lambdaPort ||
              3002
            }`,
            region: this.sqsConfig.start.region || "local",
          };

          const lambda = new Lambda(lambdaParams);

          const sqsEvent: SQSEvent = {
            Records: messages.Messages.map((message) => {
              return {
                messageId: message.MessageId as string,
                receiptHandle: message.ReceiptHandle as string,
                body: message.Body as string,
                attributes:
                  message.Attributes as unknown as SQSRecordAttributes,
                messageAttributes:
                  message.MessageAttributes as unknown as SQSMessageAttributes,
                md5OfBody: message.MD5OfBody as string,
                eventSource: "aws:sqs",
                eventSourceARN: `arn:aws:sqs:${
                  this.sqsConfig.start.region || DEFAULT_REGION
                }:${this.sqsConfig.start.accountId || DEFAULT_ACCOUNT}:${
                  q.queueName
                }`,
                awsRegion: this.sqsConfig.start.region || "local",
              };
            }),
          };

          const params = {
            FunctionName: `${this.serverless.service["service"]}-${this.serverless.service.provider.stage}-${functionName}`,
            InvocationType: "RequestResponse",
            Payload: JSON.stringify(sqsEvent),
          };

          lambda
            .invoke(params)
            .promise()
            .then((response) => {
              if (response.StatusCode !== 200 || response.FunctionError) {
                this.log(
                  `Error while processing SQS message for ${functionName}`,
                );
                this.log(response.Payload?.toString() || "");
              } else {
                const itemsToRetain: string[] = [];

                const payloadString = response.Payload;
                if (payloadString) {
                  try {
                    const payload = JSON.parse(payloadString.toString());
                    if (
                      payload.batchItemFailures &&
                      Array.isArray(payload.batchItemFailures)
                    ) {
                      payload.batchItemFailures.forEach(
                        (item: { itemIdentifier?: string }) => {
                          if (item.itemIdentifier) {
                            itemsToRetain.push(item.itemIdentifier);
                          }
                        },
                      );
                    }
                  } catch (error) {
                    this.log(
                      `Error while parsing response from lambda for ${functionName}`,
                    );
                    this.log((error as Error).message);
                  }
                }

                (messages.Messages || []).forEach((message) => {
                  if (
                    message.MessageId &&
                    itemsToRetain.includes(message.MessageId)
                  ) {
                    return;
                  }

                  if (message.ReceiptHandle && queueUrl.QueueUrl) {
                    this.sqsClient
                      ?.deleteMessage({
                        QueueUrl: queueUrl.QueueUrl,
                        ReceiptHandle: message.ReceiptHandle,
                      })
                      .promise();
                  }
                });
              }
            })
            .catch((error) => {
              this.log(
                `SQS Offline - Lambda [${
                  params.FunctionName
                }] failed - Message: ${(error as Error).message}`,
              );
            });
        }
      }

      await setTimeout(
        this.sqsConfig.stream?.readInterval || DEFAULT_READ_INTERVAL,
      );
    }
  };

  private startSQS = async () => {
    if (this.sqsConfig.start.noStart) {
      this.log("SQS Offline - [noStart] options is true. Will not start.");
    } else {
      const { port, proc, statsPort, host } = await this.spawnSQSProcess(
        this.sqsConfig.start,
      );
      proc.on("close", (code) => {
        this.log(`SQS Offline - Failed to start with code ${code}`);
      });
      this.log(
        `SQS Offline - Started on port ${port}. Visit: http://${host}:${statsPort} for stats`,
      );
    }

    if (!this.sqsConfig.start.autoCreate) {
      this.log(
        "SQS Offline - [autoCreate] options is not true. Will not create queues.",
      );
      return;
    }

    const clientConfig: SQS.ClientConfiguration = {
      accessKeyId: this.sqsConfig.start.accessKeyId || "localAwsAccessKeyId",
      endpoint: `http://${this.sqsConfig.start.host || DEFAULT_HOST}:${
        this.sqsConfig.start.port || DEFAULT_PORT
      }`,
      region: this.sqsConfig.start.region || "local",
      secretAccessKey:
        this.sqsConfig.start.secretAccessKey || "localAwsSecretAccessKey",
    };

    this.log(JSON.stringify(clientConfig, null, 2));

    await waitUntilUsedOnHost(
      Number(this.sqsConfig.start.port || DEFAULT_PORT),
      this.sqsConfig.start.host || DEFAULT_HOST,
      1000,
      30_000,
    );

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

    queues.sort((a) => {
      if (a.Properties.RedrivePolicy) {
        return 1;
      }
      return 0;
    });

    for (const queue of queues) {
      if (this.sqsClient == null) {
        continue;
      }
      await this.createQueue(this.sqsClient, queue);
    }

    await Promise.all(
      this.serverless.service.getAllFunctions().map(async (functionName) => {
        const events = this.serverless.service.getFunction(functionName).events;

        await Promise.all(
          events.map(async (event) => {
            const sqs = event["sqs"] as Queue | undefined;

            if (sqs == null) {
              return;
            }

            this.createSQSStreamReadable(functionName, sqs);
          }),
        );
      }),
    );
  };

  private stopSQS = async () => {
    this.killSQSProcess(this.sqsConfig.start);
    this.log("SQS Offline - Stopped");
  };

  private createQueue = async (sqsClient: SQS, queue: any) => {
    const { QueueName, ...Attributes } = queue.Properties;

    try {
      await sqsClient
        .createQueue({
          QueueName,
          Attributes: {
            ...(Attributes.DelaySeconds && {
              DelaySeconds: Attributes.DelaySeconds,
            }),
            ...(Attributes.MaximumMessageSize && {
              MaximumMessageSize: Attributes.MaximumMessageSize,
            }),
            ...(Attributes.MessageRetentionPeriod && {
              MessageRetentionPeriod:
                Attributes.MessageRetentionPeriod.toString(),
            }),
            ...(Attributes.ReceiveMessageWaitTimeSeconds && {
              ReceiveMessageWaitTimeSeconds:
                Attributes.ReceiveMessageWaitTimeSeconds,
            }),
            ...(Attributes.VisibilityTimeout && {
              VisibilityTimeout: Attributes.VisibilityTimeout.toString(),
            }),
            ...(Attributes.RedrivePolicy && {
              RedrivePolicy: JSON.stringify({
                deadLetterTargetArn: `arn:aws:sqs:${
                  this.sqsConfig.start.region || DEFAULT_REGION
                }:${
                  this.sqsConfig.start.accountId || DEFAULT_ACCOUNT
                }:${QueueName}-dlq`,
                maxReceiveCount:
                  Attributes.RedrivePolicy.maxReceiveCount.toString() || "3",
              }),
            }),
          },
        })
        .promise();
      this.log(`SQS Offline - Queue [${QueueName}] created`);
    } catch (error) {
      if ((error as any).code === "ResourceInUseException") {
        this.log(`SQS Offline - Queue [${QueueName}] already exists`);
      } else {
        throw error;
      }
    }
  };
}

export = ServerlessSQSOfflinePlugin;
