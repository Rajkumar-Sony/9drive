import { Serwist, type PrecacheEntry, type SerwistGlobalConfig } from 'serwist'

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined
  }
}
declare const self: ServiceWorkerGlobalScope

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  precacheOptions: {
    cleanupOutdatedCaches: true,
    navigateFallback: '/index.html',
    // Only the static app shell is cached. API responses and shared file bytes
    // must always reach the server, even when the user is offline.
    navigateFallbackDenylist: [/^\/api\//, /^\/(auth|api-keys|audit-logs|connected-accounts|files|folders|invites|provider-configs|public|storage|system|uploads)(\/|$)/],
  },
  runtimeCaching: [],
})

serwist.addEventListeners()
