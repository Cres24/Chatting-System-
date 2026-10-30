const production = process.env.NODE_ENV === "production";

export const env = {
  production,
  databaseUrl: process.env.DATABASE_URL ?? "",
  appUrl: (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  ablyKey: process.env.ABLY_API_KEY ?? "",
  blobToken: process.env.BLOB_READ_WRITE_TOKEN ?? "",
  /**
   * Access mode of the connected Blob store. A private store is recommended so
   * message media is never publicly readable; assets are streamed through the
   * authenticated /api/media and /api/avatar routes.
   */
  blobAccess: process.env.BLOB_ACCESS === "public" ? ("public" as const) : ("private" as const),
};

export function realtimeEnabled(): boolean {
  return env.ablyKey.length > 0;
}

export function blobEnabled(): boolean {
  return env.blobToken.length > 0;
}
