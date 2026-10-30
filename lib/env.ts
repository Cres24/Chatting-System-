const production = process.env.NODE_ENV === "production";

export const env = {
  production,
  /**
   * Application traffic uses the pooled Neon connection when it is available.
   * Migrations and one-off scripts use the direct URL instead.
   */
  databaseUrl:
    process.env.DATABASE_URL_POOLED ?? process.env.DATABASE_URL ?? "",
  databaseUrlDirect:
    process.env.DATABASE_URL_UNPOOLED ??
    process.env.DATABASE_URL_DIRECT ??
    process.env.DATABASE_URL ??
    "",
  appUrl: (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  ablyKey: process.env.ABLY_API_KEY ?? "",
  s3Bucket: process.env.S3_BUCKET ?? "",
  s3Endpoint: process.env.AWS_ENDPOINT_URL_S3 ?? "",
  s3Region: process.env.AWS_REGION ?? "",
  s3AccessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
  s3SecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
};

export function realtimeEnabled(): boolean {
  return env.ablyKey.length > 0;
}

export function objectStorageEnabled(): boolean {
  return Boolean(
    env.s3Bucket &&
      env.s3Endpoint &&
      env.s3Region &&
      env.s3AccessKeyId &&
      env.s3SecretAccessKey,
  );
}
