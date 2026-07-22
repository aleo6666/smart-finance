Component({
  properties: {
    option: { type: Object, value: {}, observer: 'renderChart' }
  },
  data: { canvasId: '' },
  lifetimes: {
    attached() {
      this.setData({ canvasId: 'ec-' + Date.now() + '-' + Math.floor(Math.random() * 10000) })
    },
    ready() {
      this._initChart()
    }
  },
  methods: {
    _initChart() {
      const query = this.createSelectorQuery()
      query.select('.ec-canvas').fields({ node: true, size: true }).exec(res => {
        if (!res[0] || !res[0].node) return
        const canvas = res[0].node
        const ctx = canvas.getContext('2d')
        const dpr = wx.getSystemInfoSync().pixelRatio
        canvas.width = res[0].width * dpr
        canvas.height = res[0].height * dpr
        ctx.scale(dpr, dpr)
        this._ctx = ctx
        this._canvas = canvas
        this._width = res[0].width
        this._height = res[0].height
        if (this.data.option && Object.keys(this.data.option).length > 0) {
          this.renderChart()
        }
      })
    },
    renderChart() {
      const echarts = require('../../utils/echarts.min.js')
      if (!this._ctx || !echarts) return
      const option = this.data.option
      if (!option || Object.keys(option).length === 0) return
      if (this._chart) this._chart.dispose()
      // Patch echarts init for mini program canvas
      const chart = echarts.init(this._canvas, null, {
        width: this._width, height: this._height, devicePixelRatio: wx.getSystemInfoSync().pixelRatio
      })
      chart.setOption(option)
      this._chart = chart
    },
    detached() {
      if (this._chart) { this._chart.dispose(); this._chart = null }
    }
  }
})
