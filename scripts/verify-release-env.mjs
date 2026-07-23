import { accessSync, constants, statSync } from 'node:fs'

const required = ['NARRA_PROXY_URL', 'NARRA_ACTIVATION_TOKEN', 'NARRA_UPDATE_BASE_URL', 'CSC_LINK', 'CSC_KEY_PASSWORD']
const missing = required.filter((name) => !String(process.env[name] || '').trim())
const appleApi = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'].every((name) => process.env[name])
const appleId = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'].every((name) => process.env[name])
if (!appleApi && !appleId) missing.push('Apple notarization credentials')
if (missing.length) throw new Error(`Release is fail-closed; missing: ${missing.join(', ')}`)
if (appleApi) {
  let keyFile
  try { keyFile = statSync(process.env.APPLE_API_KEY) } catch { /* handled below */ }
  if (!keyFile?.isFile() || !process.env.APPLE_API_KEY.endsWith('.p8')) {
    throw new Error('APPLE_API_KEY must point to a readable .p8 file')
  }
  accessSync(process.env.APPLE_API_KEY, constants.R_OK)
}
const gateway = new URL(process.env.NARRA_PROXY_URL)
if (gateway.protocol !== 'https:' || gateway.username || gateway.password || gateway.search || gateway.hash) {
  throw new Error('NARRA_PROXY_URL must be a clean HTTPS origin')
}
const updates = new URL(process.env.NARRA_UPDATE_BASE_URL)
if (updates.protocol !== 'https:' || updates.username || updates.password || updates.search || updates.hash) {
  throw new Error('NARRA_UPDATE_BASE_URL must be a clean HTTPS URL')
}
if (process.env.NARRA_ACTIVATION_TOKEN.length < 32) {
  throw new Error('NARRA_ACTIVATION_TOKEN must contain at least 32 characters')
}
if (process.env.NODE_ENV !== 'production') throw new Error('NODE_ENV=production is required for a release')
console.log(`Release environment validated for ${gateway.origin}`)
