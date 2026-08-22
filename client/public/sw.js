/* 智能财务顾问 PWA Service Worker
 * 策略：静态资源缓存优先（带 hash 不可变）；页面导航网络优先、离线回退缓存；
 * API 请求（/api/）一律不拦截、不缓存（2026-08-22 修复：旧版把 API 响应写入缓存导致数据陈旧）
 */
const CACHE = 'sf-pwa-v2'
const CORE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
]

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(CORE))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // API 请求：网络直通，绝不缓存（避免数据陈旧/“加载失败”假象）
  if (url.pathname.startsWith('/api/')) return

  // 带 hash 的静态资源：缓存优先，miss 时网络并回填
  if (/\/assets\//.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put(req, copy))
        return res
      }))
    )
    return
  }

  // 仅导航请求：网络优先，失败回退缓存（离线可用）；非导航不写缓存
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(req, copy))
        }
        return res
      }).catch(() =>
        caches.match(req).then((hit) => hit || caches.match('/index.html'))
      )
    )
  }
})
