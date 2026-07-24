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
    charset: 'utf8mb4',
    multipleStatements: false
  },
  pool: {
    min: 0,
    max: 10,
    afterCreate(conn, done) {
      conn.query("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci", (err) => {
        if (err) return done(err, null)
        done(null, conn)
      })
    }
  }
})

export async function closeDb() {
  await db.destroy()
}

export default db
