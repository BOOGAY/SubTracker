import { getMessage, type AppLocale } from '@subtracker/shared'
import { prisma } from '../db'
import { addInterval, toIsoDate } from '../utils/date'
import {
  endOfDayDateInTimezone,
  formatDateInTimezone,
  formatDateTimeInTimezone,
  getNowInTimezone,
  toTimezonedDayjs
} from '../utils/timezone'
import { getNotificationScanSettings } from './settings.service'
import { dispatchNotificationEvent, type NotificationChannelResult } from './channel-notification.service'
import type { NotificationDedupEntry, NotificationDispatchParams } from './notification-merge.service'

const DEFAULT_TITLE_TEMPLATE = '{{plan.name}}：{{subscription.name}}'
const DEFAULT_BODY_TEMPLATE = [
  '订阅：{{subscription.name}}',
  '通知计划：{{plan.name}}',
  '日期：{{plan.nextDate}} {{plan.notifyTime}}',
  '金额：{{plan.amountWithCurrency}}',
  '周期：每 {{plan.intervalCount}} {{plan.intervalUnit}}',
  '备注：{{plan.notes}}'
].join('\n')

type PlanScanOptions = {
  dryRun?: boolean
  locale?: AppLocale
}

export type NotificationPlanScanResult = {
  processedCount: number
  matchedPlanCount: number
  notificationCount: number
  scanTime: string
  timezone: string
  notifications: Array<{
    planId: string
    planName: string
    subscriptionId: string
    subscriptionName: string
    nextDate: string
    channelResults: NotificationChannelResult[]
  }>
}

function buildPlanPayload(
  plan: {
    id: string
    name: string
    amount: number
    currency: string
    intervalCount: number
    intervalUnit: string
    nextDate: Date
    notifyTime: string
    notes: string
  },
  subscription: {
    id: string
    name: string
    amount: number
    currency: string
    status: string
    websiteUrl: string | null
    notes: string
    notifyDaysBefore: number
    tags: Array<{ tag: { name: string } }>
  },
  timezone: string
) {
  const nextDate = formatDateInTimezone(plan.nextDate, timezone)
  return {
    id: subscription.id,
    name: subscription.name,
    nextRenewalDate: nextDate,
    notifyDaysBefore: subscription.notifyDaysBefore,
    amount: plan.amount,
    currency: plan.currency,
    status: subscription.status,
    tagNames: subscription.tags.map((item) => item.tag.name),
    websiteUrl: subscription.websiteUrl ?? '',
    notes: subscription.notes ?? '',
    phase: 'plan_due' as const,
    daysUntilRenewal: 0,
    daysOverdue: 0,
    reminderRuleTime: plan.notifyTime,
    reminderRuleDays: 0,
    plan: {
      id: plan.id,
      name: plan.name,
      amount: plan.amount,
      currency: plan.currency,
      intervalCount: plan.intervalCount,
      intervalUnit: plan.intervalUnit,
      nextDate,
      notifyTime: plan.notifyTime,
      notes: plan.notes ?? ''
    }
  }
}

function resolvePlanTrigger(planDate: Date, notifyTime: string, timezone: string) {
  const [hour, minute] = notifyTime.split(':').map(Number)
  return toTimezonedDayjs(planDate, timezone)
    .startOf('day')
    .hour(hour)
    .minute(minute)
    .second(0)
    .millisecond(0)
}

function buildPlanDispatchParams(
  plan: {
    id: string
    name: string
    amount: number
    currency: string
    intervalCount: number
    intervalUnit: string
    nextDate: Date
    notifyTime: string
    titleTemplate: string
    bodyTemplate: string
    notes: string
  },
  subscription: {
    id: string
    name: string
    amount: number
    currency: string
    status: string
    websiteUrl: string | null
    notes: string
    notifyDaysBefore: number
    tags: Array<{ tag: { name: string } }>
  },
  timezone: string
): NotificationDispatchParams {
  const payload = buildPlanPayload(plan, subscription, timezone)
  const entry: NotificationDedupEntry = {
    eventType: 'subscription.reminder_due',
    phase: 'plan_due',
    resourceKey: `notification-plan:${plan.id}`,
    periodKey: `${toIsoDate(plan.nextDate, timezone)}:${plan.notifyTime}`,
    subscriptionId: subscription.id,
    payload,
    customTemplate: {
      titleTemplate: plan.titleTemplate.trim() || DEFAULT_TITLE_TEMPLATE,
      bodyTemplate: plan.bodyTemplate.trim() || DEFAULT_BODY_TEMPLATE
    }
  }

  return {
    eventType: entry.eventType,
    resourceKey: entry.resourceKey,
    periodKey: entry.periodKey,
    subscriptionId: entry.subscriptionId,
    payload: entry.payload,
    dedupEntries: [entry],
    customTemplate: entry.customTemplate
  }
}

async function advancePlanIfDelivered(
  plan: {
    id: string
    nextDate: Date
    intervalCount: number
    intervalUnit: 'day' | 'week' | 'month' | 'quarter' | 'year'
    autoAdvance: boolean
  },
  now: Date,
  timezone: string
) {
  if (!plan.autoAdvance) {
    await prisma.notificationPlan.update({
      where: { id: plan.id },
      data: { enabled: false }
    })
    return
  }

  let nextDate = addInterval(plan.nextDate, plan.intervalCount, plan.intervalUnit, timezone)
  let guard = 0
  while (!toTimezonedDayjs(nextDate, timezone).isAfter(toTimezonedDayjs(now, timezone), 'day') && guard < 120) {
    nextDate = addInterval(nextDate, plan.intervalCount, plan.intervalUnit, timezone)
    guard += 1
  }

  await prisma.notificationPlan.update({
    where: { id: plan.id },
    data: { nextDate }
  })
}

export async function scanNotificationPlans(today = new Date(), options: PlanScanOptions = {}): Promise<NotificationPlanScanResult> {
  const settings = await getNotificationScanSettings()
  const timezone = settings.timezone
  const locale = options.locale ?? settings.locale
  const now = getNowInTimezone(today, timezone).second(0).millisecond(0)
  const plans = await prisma.notificationPlan.findMany({
    where: {
      enabled: true,
      nextDate: { lte: endOfDayDateInTimezone(today, timezone) },
      subscription: {
        status: { in: ['active', 'expired'] },
        webhookEnabled: true
      }
    },
    include: {
      subscription: {
        include: { tags: { include: { tag: true } } }
      }
    },
    orderBy: [{ nextDate: 'asc' }, { notifyTime: 'asc' }]
  })

  const notifications: NotificationPlanScanResult['notifications'] = []
  let matchedPlanCount = 0

  for (const plan of plans) {
    const trigger = resolvePlanTrigger(plan.nextDate, plan.notifyTime, timezone)
    if (now.isBefore(trigger)) continue

    matchedPlanCount += 1
    const params = buildPlanDispatchParams(plan, plan.subscription, timezone)
    const channelResults = options.dryRun
      ? [{ channel: 'email' as const, status: 'skipped' as const, message: 'dry_run' }]
      : await dispatchNotificationEvent(params, { locale })
    const hasFailure = channelResults.some((item) => item.status === 'failed')
    const hasSuccess = channelResults.some((item) => item.status === 'success')

    if (!options.dryRun && hasSuccess && !hasFailure) {
      await advancePlanIfDelivered(plan, today, timezone)
    }

    notifications.push({
      planId: plan.id,
      planName: plan.name,
      subscriptionId: plan.subscription.id,
      subscriptionName: plan.subscription.name,
      nextDate: formatDateInTimezone(plan.nextDate, timezone),
      channelResults
    })
  }

  return {
    processedCount: plans.length,
    matchedPlanCount,
    notificationCount: notifications.length,
    scanTime: formatDateTimeInTimezone(now.toDate(), timezone),
    timezone,
    notifications
  }
}

export function formatNotificationPlanScan(result: NotificationPlanScanResult) {
  const successful = result.notifications.reduce(
    (count, notification) => count + notification.channelResults.filter((item) => item.status === 'success').length,
    0
  )
  return getMessage('zh-CN', 'scheduler.logs.notificationPlanScan', {
    processedCount: result.processedCount,
    matchedPlanCount: result.matchedPlanCount,
    notificationCount: result.notificationCount,
    successful
  })
}
