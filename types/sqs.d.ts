export interface SQSConfig {
  stage?: string[];
  start: SQSStartConfig;
  stream?: SQSStreamConfig;
}

interface SQSStartConfig extends SQSLaunchOptions {
  migrate?: boolean | null;
  // seed?: boolean | null;
  noStart?: boolean | null;
}

interface SQSStreamConfig {
  readInterval?: number | null;
  startAt?: string | null;
  startAfter?: string | null;
}

export interface SQSLaunchOptions {
  cors?: string | null;
  sqsPath?: string | null;
  delayTransientStatuses?: boolean | null;
  inMemory?: boolean | null;
  optimizeDbBeforeStartup?: boolean | null;
  port?: number | string | null;
  statsPort?: number | string | null;
  host?: string | null;
  sharedDb?: boolean | null;

  heapInitial?: string | null;
  heapMax?: string | null;

  accessKeyId?: string | null;
  secretAccessKey?: string | null;
  region?: string | null;
}

export interface Stream {
  enabled: boolean;
  type: string;
  arn: Record<string, string>;
  tableName: string;
  batchSize: number;
  startingPosition: string;
}
