const { api } = require('../../utils/api.js')
const { setToken, getToken } = require('../../utils/auth.js')

Page({
  data: {
    mode: 'login',
    username: '',
    password: '',
    confirmPassword: '',
    loading: false,
    error: ''
  },

  onLoad() {
    if (getToken()) {
      wx.switchTab({ url: '/pages/chat/chat' })
    }
  },

  switchMode(e) {
    const mode = e.currentTarget.dataset.mode
    this.setData({ mode, error: '' })
  },

  onUsernameInput(e) { this.setData({ username: e.detail.value }) },
  onPasswordInput(e) { this.setData({ password: e.detail.value }) },
  onConfirmInput(e) { this.setData({ confirmPassword: e.detail.value }) },

  async onGetPhoneNumber(e) {
    if (e.detail.errMsg !== 'getPhoneNumber:ok') {
      this.setData({ error: '授权已取消' })
      return
    }
    this.setData({ loading: true, error: '' })
    try {
      const loginRes = await new Promise((resolve, reject) => {
        wx.login({ success: resolve, fail: reject })
      })
      const res = await api.wechatPhoneLogin(loginRes.code, e.detail.encryptedData, e.detail.iv)
      if (res.success) {
        setToken(res.data.token)
        wx.switchTab({ url: '/pages/chat/chat' })
      } else {
        this.setData({ error: res.error || '登录失败' })
      }
    } catch (err) {
      this.setData({ error: '登录失败，请稍后重试' })
    } finally {
      this.setData({ loading: false })
    }
  },

  async doSubmit() {
    const { mode, username, password, confirmPassword } = this.data
    if (!username.trim() || !password) { this.setData({ error: '请填写用户名和密码' }); return }
    if (password.length < 6) { this.setData({ error: '密码至少6位' }); return }
    if (mode === 'register' && password !== confirmPassword) { this.setData({ error: '两次密码不一致' }); return }

    this.setData({ loading: true, error: '' })
    try {
      const res = mode === 'login'
        ? await api.login(username.trim(), password)
        : await api.register(username.trim(), password)
      if (res.success) {
        setToken(res.data.token)
        wx.switchTab({ url: '/pages/chat/chat' })
      } else {
        this.setData({ error: res.error || '操作失败' })
      }
    } catch (err) {
      this.setData({ error: '网络错误，请稍后重试' })
    } finally {
      this.setData({ loading: false })
    }
  }
})
