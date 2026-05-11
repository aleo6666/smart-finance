import { v4 as uuidv4 } from 'uuid'

export function deviceIdMiddleware(req, res, next) {
  let deviceId = req.headers['x-device-id']

  if (!deviceId || deviceId === 'null' || deviceId === 'undefined') {
    deviceId = uuidv4()
    res.setHeader('X-Device-Id', deviceId)
  }

  req.deviceId = deviceId
  next()
}
