/** Cloudflare R2 upload (S3 API) via aws4fetch SigV4. Stateless. */
import { AwsClient } from "aws4fetch";
import { getConfig } from "../config";

/** Build the object key for a job's video: `<prefix><base>-<jobId>.mp4`. */
export function objectKey(base: string, jobId: string, prefix = ""): string {
  return `${prefix}${base}-${jobId}.mp4`;
}

/**
 * Upload a local mp4 to R2 and return its public URL. Streams the file with an
 * UNSIGNED-PAYLOAD hash so large videos are not buffered in memory; R2 still
 * gets a real Content-Length so players see the right duration/size.
 */
export async function uploadVideo(filePath: string, key: string): Promise<string> {
  const cfg = getConfig();
  const client = new AwsClient({
    accessKeyId: cfg.r2AccessKeyId,
    secretAccessKey: cfg.r2SecretAccessKey,
    region: "auto",
    service: "s3",
  });

  const file = Bun.file(filePath);
  const url = `${cfg.r2Endpoint}/${cfg.r2Bucket}/${key}`;
  const res = await client.fetch(url, {
    method: "PUT",
    body: file.stream(),
    duplex: "half",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(file.size),
      "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    },
  } as RequestInit);
  if (!res.ok) {
    throw new Error(`R2 upload failed: ${res.status} ${await res.text()}`);
  }
  return `${cfg.r2PublicBaseUrl}/${key}`;
}
