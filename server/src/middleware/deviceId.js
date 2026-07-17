import { v4 as uuidv4 } from 'uuid'
import db from '../db.js'

async function trackDevice(deviceId) {
  await db('devices')
    .insert({ device_id: deviceId })
    .onConflict('device_id')
    .merge({ last_seen: db.fn.now() })
}

export function deviceIdMiddleware(req, res, next) {
  let deviceId = req.headers['x-device-id']

  if (!deviceId || deviceId === 'null' || deviceId === 'undefined') {
    deviceId = uuidv4()
    res.setHeader('X-Device-Id', deviceId)
  }

  req.deviceId = deviceId
  trackDevice(deviceId).catch(error => console.warn('[Device] track failed:', error.message))
  next()
}
