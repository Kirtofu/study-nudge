import type { SecretStoreStatus } from '@shared/types'
import { appDataDir, join } from '@tauri-apps/api/path'
import { Stronghold, type Client, type Store } from '@tauri-apps/plugin-stronghold'

const vaultPassword = 'Nudge::local-stronghold::v2'
const vaultClient = 'nudge-secrets-v2'
const SECRET_API_KEY = 'recommendation-api-key'
const SECRET_WEBDAV_PASSWORD = 'webdav-password'
const SECRET_SYNC_PASSPHRASE = 'sync-passphrase'
const decoder = new TextDecoder()
let strongholdPromise: Promise<{ stronghold: Stronghold; client: Client; store: Store }> | null =
  null

async function getSecretStore(): Promise<{ stronghold: Stronghold; client: Client; store: Store }> {
  if (!strongholdPromise) {
    strongholdPromise = (async () => {
      const path = await join(await appDataDir(), 'nudge-vault.hold')
      const stronghold = await Stronghold.load(path, vaultPassword)
      let client: Client
      try {
        client = await stronghold.loadClient(vaultClient)
      } catch {
        client = await stronghold.createClient(vaultClient)
      }
      return { stronghold, client, store: client.getStore() }
    })()
  }
  return strongholdPromise
}

async function readLegacySecret(key: string): Promise<string> {
  const { store } = await getSecretStore()
  const value = await store.get(key)
  return value ? decoder.decode(value) : ''
}

export async function migrateLegacySecrets(
  invokeImport: (input: Record<string, string | null>) => Promise<SecretStoreStatus>
): Promise<SecretStoreStatus> {
  return invokeImport({
    recommendationApiKey: (await readLegacySecret(SECRET_API_KEY)) || null,
    webdavPassword: (await readLegacySecret(SECRET_WEBDAV_PASSWORD)) || null,
    syncPassphrase: (await readLegacySecret(SECRET_SYNC_PASSPHRASE)) || null
  })
}
