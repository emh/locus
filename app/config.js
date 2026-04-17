globalThis.LOCUS_CONFIG = {
  apiBaseUrl: ["localhost", "127.0.0.1"].includes(globalThis.location?.hostname)
    ? ""
    : "https://locus-place.emh.workers.dev",
  syncBaseUrl: ["localhost", "127.0.0.1"].includes(globalThis.location?.hostname)
    ? ""
    : "https://locus-sync.emh.workers.dev"
};
