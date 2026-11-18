export const REPLICATION_SCHEDULES = ['0 * * * *', '0 0 * * *', '0 0 * * 1'] as const
export type ReplicationSchedule = typeof REPLICATION_SCHEDULES[number]

export function nextReplicationRun(schedule: ReplicationSchedule, after: Date): Date {
  const next = new Date(after)
  next.setUTCSeconds(0, 0)
  if (schedule === '0 * * * *') {
    next.setUTCHours(next.getUTCHours() + 1, 0, 0, 0)
  } else {
    next.setUTCHours(0, 0, 0, 0)
    next.setUTCDate(next.getUTCDate() + 1)
    if (schedule === '0 0 * * 1') {
      while (next.getUTCDay() !== 1) next.setUTCDate(next.getUTCDate() + 1)
    }
  }
  return next
}
