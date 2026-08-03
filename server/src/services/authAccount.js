import db from '../db.js'

export async function createDefaultLedger(userId, database = db) {
  const existing = await database('ledgers').where({ user_id: userId }).first()
  if (!existing) {
    return database('ledgers').insert({
      user_id: userId,
      name: '我的账本',
      base_currency: 'CNY'
    })
  }
}

export async function migrateGuestRecords(userId, deviceId, database = db) {
  if (!deviceId || deviceId === 'null' || deviceId === 'undefined') return 0
  return database('records')
    .where({ device_id: deviceId, user_id: null })
    .update({ user_id: userId })
}

export function createAuthAccountService(database = db) {
  return {
    findByEmail(email) {
      return database('users').where({ email }).first()
    },

    async createEmailAccount({
      email,
      passwordHash,
      nickname,
      verifiedAt,
      deviceId
    }) {
      const userId = await database.transaction(async trx => {
        const [createdUserId] = await trx('users').insert({
          email,
          email_verified_at: verifiedAt,
          password: passwordHash,
          nickname
        })
        await createDefaultLedger(createdUserId, trx)
        return createdUserId
      })

      await migrateGuestRecords(userId, deviceId, database)
      return userId
    },

    async completeLogin(userId, deviceId) {
      await database('users')
        .where({ id: userId })
        .update({ last_login_at: database.fn.now() })
      return migrateGuestRecords(userId, deviceId, database)
    },

    updatePassword(userId, passwordHash) {
      return database('users')
        .where({ id: userId })
        .update({ password: passwordHash })
    }
  }
}
