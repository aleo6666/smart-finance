Component({
  properties: {
    records: { type: Array, value: [] },
    ocrSessionId: { type: String, value: '' },
    saving: { type: Boolean, value: false }
  },
  data: {
    categories: ['餐饮', '交通', '购物', '娱乐', '住房', '医疗', '教育', '通讯', '礼物', '其他']
  },
  methods: {
    onFieldChange(e) {
      const { index, field } = e.currentTarget.dataset
      const records = this.data.records
      records[index][field] = e.detail.value
      this.setData({ records })
    },
    onCategoryChange(e) {
      const index = e.currentTarget.dataset.index
      const records = this.data.records
      records[index].category = this.data.categories[e.detail.value]
      this.setData({ records })
    },
    onRemove(e) { this.triggerEvent('remove', { index: e.currentTarget.dataset.index }) },
    onCancel() { this.triggerEvent('cancel') },
    onConfirm() { this.triggerEvent('confirm') }
  }
})
