declare global {
  const HACHIMICODE_VERSION: string
  const HACHIMICODE_CHANNEL: string
}

export const InstallationVersion = typeof HACHIMICODE_VERSION === "string" ? HACHIMICODE_VERSION : "local"
export const InstallationChannel = typeof HACHIMICODE_CHANNEL === "string" ? HACHIMICODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
