import knex from 'knex'
import config from './config.js'

const db = knex({
  client: 'mysql2',
  connection: {
    host: config.db.host,
    port: config.db.port,
    database: config.db.name,
    user: config.db.user,
    password: config.db.password,
    multipleStatements: false
  },
  pool: {
    min: 0,
    max: 10
  }
})

export async function closeDb() {
  await db.destroy()
}

export default db
