import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import { PrismaClient } from '../generated/prisma/client.js'
import { env } from './env.js'

const databaseUrl = new URL(env.DATABASE_URL)
if (databaseUrl.protocol !== 'mysql:' && databaseUrl.protocol !== 'mariadb:') {
  throw new Error('DATABASE_URL must use the mysql or mariadb protocol.')
}

// The MariaDB driver uses milliseconds for connection timeouts and seconds for
// idle timeout. Keep the old Prisma URL options usable during the migration.
const legacyOptions: Record<string, [string, number]> = {
  connection_limit: ['connectionLimit', 1],
  pool_timeout: ['acquireTimeout', 1000],
  connect_timeout: ['connectTimeout', 1000],
  max_idle_connection_lifetime: ['idleTimeout', 1],
}
for (const [oldName, [newName, multiplier]] of Object.entries(legacyOptions)) {
  const value = databaseUrl.searchParams.get(oldName)
  if (value === null) continue
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) throw new Error(`Invalid DATABASE_URL option: ${oldName}`)
  databaseUrl.searchParams.delete(oldName)
  databaseUrl.searchParams.set(newName, String(numeric * multiplier))
}
if (!databaseUrl.searchParams.has('connectionLimit')) databaseUrl.searchParams.set('connectionLimit', '10')
if (!databaseUrl.searchParams.has('acquireTimeout')) databaseUrl.searchParams.set('acquireTimeout', '10000')
if (!databaseUrl.searchParams.has('connectTimeout')) databaseUrl.searchParams.set('connectTimeout', '5000')
if (!databaseUrl.searchParams.has('idleTimeout')) databaseUrl.searchParams.set('idleTimeout', '300')

export const prisma = new PrismaClient({ adapter: new PrismaMariaDb(databaseUrl.toString()) })
