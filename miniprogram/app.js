const { getToken } = require('./utils/auth.js')
const { api } = require('./utils/api.js')

App({
  globalData: {
    token: '',
    user: null,
    ledgers: []
  },

  onLaunch() {
    const token = getToken()
    if (token) {
      this.globalData.token = token
      api.setToken(token)
      this.loadUser()
    }
  },

  async loadUser() {
    try {
      const res = await api.getMe()
      if (res.success) {
        this.globalData.user = res.data.user
        this.globalData.ledgers = res.data.ledgers
      }
    } catch {
      this.globalData.token = ''
    }
  }
})
