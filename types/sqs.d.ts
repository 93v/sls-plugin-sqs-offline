export interface SQSConfig {
  stage?: string[];
  start: SQSStartConfig;
  stream?: SQSStreamConfig;
}

interface SQSStartConfig extends SQSLaunchOptions {
  autoCreate?: boolean | null;
  // seed?: boolean | null;
  noStart?: boolean | null;
}

interface SQSStreamConfig {
  readInterval?: number | null;
  startAt?: string | null;
  startAfter?: string | null;
}

export interface SQSLaunchOptions {
  port?: number | string | null;
  statsPort?: number | string | null;
  host?: string | null;
  accountId?: string | null;

  heapInitial?: string | null;
  heapMax?: string | null;

  accessKeyId?: string | null;
  secretAccessKey?: string | null;
  region?: string | null;
}

export interface Queue {
  arn: Record<string, string>;
  batchSize: number;
  maximumBatchingWindow: number;
  queueName: string;
}
