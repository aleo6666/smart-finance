import { v4 as uuidv4 } from 'uuid'
import { trackDevice } from '../db.js'

export function deviceIdMiddleware(req, res, next) {
  let deviceId = req.headers['x-device-id']

  if (!deviceId || deviceId === 'null' || deviceId === 'undefined') {
    deviceId = uuidv4()
    res.setHeader('X-Device-Id', deviceId)
  }

  req.deviceId = deviceId
  // 异步追踪设备访问，不阻塞请求
  try { trackDevice(deviceId) } catch {}
  next()
}
