import { readFileSync } from 'node:fs'
import { mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import { sharedMessages } from '@subtracker/shared'
import SubscriptionFormModal from '@/components/SubscriptionFormModal.vue'

vi.mock('@/composables/settings-query', () => ({
  useSettingsQuery: () => ({ data: ref({ timezone: 'Asia/Shanghai' }) })
}))

vi.mock('@/utils/localized-message', () => ({
  useLocalizedMessage: () => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn()
  })
}))

describe('subscription form modal frequency and local logo search', () => {
  it('renders the complete create form instead of an empty modal body', async () => {
    const runtimeErrors: unknown[] = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    const wrapper = mount(SubscriptionFormModal, {
      attachTo: host,
      props: {
        show: true,
        tags: [],
        currencies: ['CNY']
      },
      global: {
        config: {
          errorHandler(error) {
            runtimeErrors.push(error)
          }
        }
      }
    })
    await nextTick()

    expect(runtimeErrors).toEqual([])
    expect(document.body.textContent).toContain('新建订阅')
    expect(document.body.textContent).toContain('名称')
    expect(document.body.textContent).toContain('金额')
    expect(document.body.textContent).toContain('独立通知计划')
    expect(document.body.textContent).toContain('添加计划')
    expect(document.body.textContent).toContain('保存')

    const addPlanButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('添加计划')
    )
    expect(addPlanButton).toBeDefined()
    addPlanButton?.click()
    await nextTick()

    expect(runtimeErrors).toEqual([])
    expect(document.body.textContent).toContain('通知计划 1')
    expect(document.body.textContent).toContain('{{plan.name}}')
    expect(document.body.textContent).toContain('{{subscription.name}}')

    wrapper.unmount()
    host.remove()
  })

  it('keeps notification template variables out of vue-i18n messages so the form can render', () => {
    const i18n = createI18n({
      legacy: false,
      locale: 'zh-CN',
      messages: sharedMessages
    })
    const source = readFileSync('src/components/SubscriptionFormModal.vue', 'utf8')

    expect(i18n.global.t('subscriptions.form.notificationPlanTitlePlaceholder')).toBe('例如：')
    expect(i18n.global.t('subscriptions.form.notificationPlanBodyPlaceholder')).toBe('支持变量：')
    expect(i18n.global.t('subscriptions.form.notificationPlanVariables')).toBe('可用变量：')
    expect(source).toContain("const notificationPlanTitleExample = '{{plan.name}}: {{subscription.name}}'")
    expect(source).toContain("const notificationPlanBodyVariables = '{{subscription.name}}, {{plan.name}}")
  })

  it('keeps frequency quick picks while allowing custom positive integer input', () => {
    const source = readFileSync('src/components/SubscriptionFormModal.vue', 'utf8')

    expect(source).toContain('filterable')
    expect(source).toContain('tag')
    expect(source).toContain(':on-create="handleCreateFrequencyOption"')
    expect(source).toContain('buildFrequencyOptions(form.billingIntervalCount)')
    expect(source).toContain("message.warning(t('subscriptions.messages.invalidCustomFrequency'))")
  })

  it('adds search filtering to the local logo library tab', () => {
    const source = readFileSync('src/components/SubscriptionFormModal.vue', 'utf8')

    expect(source).toContain("v-model:value=\"localLogoSearchQuery\"")
    expect(source).toContain("t('subscriptions.form.logo.localSearchPlaceholder')")
    expect(source).toContain('filteredLocalLogoLibrary.length')
    expect(source).toContain('filterLocalLogoLibrary(localLogoLibrary.value, localLogoSearchQuery.value)')
    expect(source).toContain("t('subscriptions.form.logo.noLocalMatches')")
  })

  it('clears cached local logo library data when the modal closes so usage counts refresh on reopen', () => {
    const source = readFileSync('src/components/SubscriptionFormModal.vue', 'utf8')

    expect(source).toContain('watch(')
    expect(source).toContain('() => props.show')
    expect(source).toContain('localLogoLibrary.value = []')
  })

  it('keeps the mobile footer actions compact instead of stretching the whole edit form', () => {
    const source = readFileSync('src/components/SubscriptionFormModal.vue', 'utf8')

    expect(source).toContain('.form-footer {')
    expect(source).toContain('justify-content: flex-start;')
    expect(source).toContain('.form-footer__toggles,')
    expect(source).toContain('.form-footer__actions {')
    expect(source).toContain('flex: none;')
    expect(source).toContain('align-items: center;')
  })
})
