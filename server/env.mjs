export function parseEnvInt(env, name, fallback, max) {
  const value = Number(env[name] || fallback)
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`)
  }
  return value
}
