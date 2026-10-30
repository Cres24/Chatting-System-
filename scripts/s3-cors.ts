import { PutBucketCorsCommand, S3Client } from "@aws-sdk/client-s3";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

const bucket = required("S3_BUCKET");
const appUrl = process.env.APP_URL ?? "http://localhost:3000";

const origins = new Set<string>([
  "http://localhost:3000",
  "http://localhost:3100",
  "https://*.vercel.app",
]);
try {
  origins.add(new URL(appUrl).origin);
} catch {
  console.warn(`APP_URL is not a valid URL: ${appUrl}`);
}

const client = new S3Client({
  forcePathStyle: true,
  region: required("AWS_REGION"),
  endpoint: required("AWS_ENDPOINT_URL_S3"),
  credentials: {
    accessKeyId: required("AWS_ACCESS_KEY_ID"),
    secretAccessKey: required("AWS_SECRET_ACCESS_KEY"),
  },
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

await client.send(
  new PutBucketCorsCommand({
    Bucket: bucket,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedHeaders: ["content-type"],
          AllowedMethods: ["PUT", "GET", "HEAD"],
          AllowedOrigins: [...origins],
          ExposeHeaders: ["etag"],
          MaxAgeSeconds: 3600,
        },
      ],
    },
  }),
);

console.log(`Configured CORS for ${bucket}:`);
for (const origin of origins) console.log(`  ${origin}`);
