import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";

const LOOPBACK: Record<string, true> = { "127.0.0.1": true, localhost: true, "::1": true };

function testEndpoint(): string {
  const url = new URL(process.env.BONTE_TEST_S3_ENDPOINT || "http://127.0.0.1:19000");
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Test S3 endpoint must be http or https.");
  }
  if (!LOOPBACK[url.hostname]) {
    throw new Error(`Test S3 endpoint must be loopback, got ${url.hostname}`);
  }
  return `${url.protocol}//${url.host}`;
}

/** Dedicated test MinIO only. Ignores production BONTE_S3_* / AWS_* values. */
export function applyTestS3Env(): { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string } {
  const endpoint = testEndpoint();
  const bucket = process.env.BONTE_TEST_S3_BUCKET || "bonte-test-attachments";
  const region = process.env.BONTE_TEST_S3_REGION || "us-east-1";
  const accessKeyId = process.env.BONTE_TEST_S3_ACCESS_KEY_ID || "minioadmin";
  const secretAccessKey = process.env.BONTE_TEST_S3_SECRET_ACCESS_KEY || "minioadmin";
  process.env.BONTE_S3_ENDPOINT = endpoint;
  process.env.BONTE_S3_BUCKET = bucket;
  process.env.BONTE_S3_REGION = region;
  process.env.AWS_ACCESS_KEY_ID = accessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = secretAccessKey;
  process.env.AWS_EC2_METADATA_DISABLED = "true";
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_PROFILE;
  delete process.env.AWS_SHARED_CREDENTIALS_FILE;
  delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  delete process.env.AWS_WEB_IDENTITY_TOKEN_FILE;
  return { endpoint, bucket, region, accessKeyId, secretAccessKey };
}

let ready: Promise<void> | undefined;

export async function ensureTestS3(): Promise<void> {
  const { endpoint, bucket, region, accessKeyId, secretAccessKey } = applyTestS3Env();
  ready ??= (async () => {
    const client = new S3Client({
      region,
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      } catch (error) {
        if (!(error && typeof error === "object" && "name" in error && error.name === "BucketAlreadyOwnedByYou")) throw error;
      }
    }
  })();
  try {
    await ready;
  } catch (error) {
    ready = undefined;
    throw error;
  }
}
