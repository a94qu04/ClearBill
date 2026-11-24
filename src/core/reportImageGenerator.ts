import type { Project, Transaction } from '@/schemas/ledgerSchema'
import type { SettleUpResult } from '@/core/settleUpEngine'
import { calculateCategoryStats } from '@/core/categoryStats'
import { formatCurrencyAmount } from '@/core/currency'

export interface LongReportLabels {
  brandTitle: string
  totalSpendLabel: string
  memberCountLabel: string
  categorySectionTitle: string
  memberSectionTitle: string
  spentLabel: string
  paidLabel: string
  shouldReceive: string
  shouldPay: string
  settled: string
  transfersSectionTitle: string
  allSettledText: string
  entriesSectionTitle: string
  refundBadge: string
  footerTagline: string
  resolveCategoryLabel: (categoryKey: string) => string
  resolveCategoryColor: (categoryKey: string) => string
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

function truncateText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let trimmed = text
  while (trimmed.length > 1 && ctx.measureText(`${trimmed}…`).width > maxWidth) {
    trimmed = trimmed.slice(0, -1)
  }
  return `${trimmed}…`
}

/**
 * 透過原生 Canvas 2D 產生高解析度（2x DPR）的 ClearBill 長截圖結算報表 PNG Blob
 * 內含：深色標頭總覽、消費結構圓餅圖、各成員支出與淨收支、轉帳建議與完整消費明細
 */
export async function generateProjectReportPngBlob(
  project: Project,
  settleUp: SettleUpResult,
  expenses: Transaction[],
  labels: LongReportLabels,
  locale = 'zh-TW',
): Promise<Blob> {
  if (typeof document === 'undefined') {
    throw new Error('ERR_NO_CANVAS_ENV')
  }

  const W = 750
  const PAD = 32
  const CARD_W = W - PAD * 2
  const DPR = 2

  const memberNameMap = new Map<string, string>()
  const memberColorMap = new Map<string, string>()
  for (const m of project.members) {
    memberNameMap.set(m.id, m.name)
    memberColorMap.set(m.id, m.avatarColor || '#10b981')
  }
  const nameOf = (id: string) => memberNameMap.get(id) ?? id
  const colorOf = (id: string) => memberColorMap.get(id) ?? '#10b981'
  const fmt = (amount: number, cur = project.baseCurrency) =>
    formatCurrencyAmount(amount, cur, locale)

  const catStats = calculateCategoryStats(expenses, project.baseCurrency)
  const validEntries = expenses
    .filter((tx) => !tx.isDeleted && (tx.type === 'expense' || tx.type === 'refund'))
    .sort((a, b) => {
      const d = b.date.localeCompare(a.date)
      if (d !== 0) return d
      return b.time.localeCompare(a.time)
    })

  // 動態估算整張長截圖總高度
  const headerH = 152
  const pieCardH =
    catStats.items.length > 0 ? Math.max(230, 88 + catStats.items.length * 36) : 0
  const memberCardH = 74 + settleUp.balances.length * 76
  const transferCardH =
    settleUp.transfers.length > 0
      ? 74 + settleUp.transfers.length * 56
      : 120
  const entriesCardH =
    validEntries.length > 0 ? 74 + validEntries.length * 58 : 0
  const footerH = 64

  const gap = 20
  let totalH = PAD + headerH + gap
  if (pieCardH > 0) totalH += pieCardH + gap
  totalH += memberCardH + gap + transferCardH + gap
  if (entriesCardH > 0) totalH += entriesCardH + gap
  totalH += footerH

  const canvas = document.createElement('canvas')
  canvas.width = W * DPR
  canvas.height = totalH * DPR
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('ERR_NO_CANVAS_CTX')

  ctx.scale(DPR, DPR)
  const fontStack =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", "Microsoft JhengHei", "Hiragino Sans", sans-serif'

  // 背景
  ctx.fillStyle = '#f1f5f9'
  ctx.fillRect(0, 0, W, totalH)

  let y = PAD

  // 1. 頂部深色品牌與專案總額卡片
  drawRoundedRect(ctx, PAD, y, CARD_W, headerH, 24)
  ctx.fillStyle = '#0f172a'
  ctx.fill()

  ctx.fillStyle = '#34d399'
  ctx.font = `700 18px ${fontStack}`
  ctx.fillText(labels.brandTitle, PAD + 28, y + 38)

  ctx.fillStyle = '#94a3b8'
  ctx.font = `600 15px ${fontStack}`
  ctx.textAlign = 'right'
  ctx.fillText(
    `${labels.memberCountLabel} · ${project.baseCurrency}`,
    PAD + CARD_W - 28,
    y + 38,
  )
  ctx.textAlign = 'left'

  ctx.fillStyle = '#ffffff'
  ctx.font = `800 28px ${fontStack}`
  ctx.fillText(
    truncateText(ctx, project.name, CARD_W - 56),
    PAD + 28,
    y + 78,
  )

  ctx.fillStyle = '#94a3b8'
  ctx.font = `600 15px ${fontStack}`
  ctx.fillText(labels.totalSpendLabel, PAD + 28, y + 114)

  ctx.fillStyle = '#34d399'
  ctx.font = `800 32px ${fontStack}`
  ctx.textAlign = 'right'
  ctx.fillText(
    fmt(settleUp.totalProjectExpense, project.baseCurrency),
    PAD + CARD_W - 28,
    y + 124,
  )
  ctx.textAlign = 'left'

  y += headerH + gap

  // 2. 消費結構圓餅圖卡片
  if (pieCardH > 0) {
    drawRoundedRect(ctx, PAD, y, CARD_W, pieCardH, 22)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.strokeStyle = '#e2e8f0'
    ctx.lineWidth = 1.5
    ctx.stroke()

    ctx.fillStyle = '#334155'
    ctx.font = `700 18px ${fontStack}`
    ctx.fillText(labels.categorySectionTitle, PAD + 24, y + 36)

    // 左側 Donut 圓餅圖
    const cx = PAD + 112
    const cy = y + 54 + (pieCardH - 68) / 2
    const radius = 64
    const strokeW = 24
    let startAngle = -Math.PI / 2

    for (const item of catStats.items) {
      const fraction =
        catStats.positiveChartTotal > 0
          ? item.amount / catStats.positiveChartTotal
          : 0
      const sweep = Math.max(0.03, fraction * Math.PI * 2)
      ctx.beginPath()
      ctx.arc(cx, cy, radius, startAngle, startAngle + sweep)
      ctx.strokeStyle = labels.resolveCategoryColor(item.categoryKey)
      ctx.lineWidth = strokeW
      ctx.stroke()
      startAngle += sweep
    }

    // 圓心金額文字
    ctx.fillStyle = '#0f172a'
    ctx.font = `800 15px ${fontStack}`
    ctx.textAlign = 'center'
    ctx.fillText(
      truncateText(ctx, fmt(catStats.totalNetExpense), 92),
      cx,
      cy + 6,
    )
    ctx.textAlign = 'left'

    // 右側分類清單
    const legendX = PAD + 216
    const legendW = CARD_W - 240
    let ly = y + 72
    for (const item of catStats.items) {
      const color = labels.resolveCategoryColor(item.categoryKey)
      ctx.beginPath()
      ctx.arc(legendX + 6, ly - 5, 6, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()

      ctx.fillStyle = '#1e293b'
      ctx.font = `600 16px ${fontStack}`
      const catLabel = truncateText(
        ctx,
        labels.resolveCategoryLabel(item.categoryKey),
        legendW - 170,
      )
      ctx.fillText(catLabel, legendX + 20, ly)

      ctx.textAlign = 'right'
      ctx.fillStyle = '#64748b'
      ctx.font = `600 15px ${fontStack}`
      ctx.fillText(`${item.percentage}%`, legendX + legendW - 102, ly)

      ctx.fillStyle = '#0f172a'
      ctx.font = `700 16px ${fontStack}`
      ctx.fillText(fmt(item.amount), legendX + legendW, ly)
      ctx.textAlign = 'left'

      ly += 36
    }

    y += pieCardH + gap
  }

  // 3. 各成員總支出與淨收支卡片
  drawRoundedRect(ctx, PAD, y, CARD_W, memberCardH, 22)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.strokeStyle = '#e2e8f0'
  ctx.lineWidth = 1.5
  ctx.stroke()

  ctx.fillStyle = '#334155'
  ctx.font = `700 18px ${fontStack}`
  ctx.fillText(labels.memberSectionTitle, PAD + 24, y + 36)

  let my = y + 58
  for (const bal of settleUp.balances) {
    drawRoundedRect(ctx, PAD + 20, my, CARD_W - 40, 64, 14)
    ctx.fillStyle = '#f8fafc'
    ctx.fill()

    // 左側成員色條
    drawRoundedRect(ctx, PAD + 20, my, 6, 64, 3)
    ctx.fillStyle = colorOf(bal.memberId)
    ctx.fill()

    ctx.fillStyle = '#0f172a'
    ctx.font = `700 18px ${fontStack}`
    ctx.fillText(
      truncateText(ctx, nameOf(bal.memberId), 240),
      PAD + 40,
      my + 26,
    )

    ctx.fillStyle = '#64748b'
    ctx.font = `500 14px ${fontStack}`
    ctx.fillText(
      `${labels.spentLabel} ${fmt(bal.totalExpense)}  ·  ${labels.paidLabel} ${fmt(bal.totalPaid)}`,
      PAD + 40,
      my + 50,
    )

    const netSign = bal.netAmount > 0 ? '+' : ''
    ctx.textAlign = 'right'
    ctx.fillStyle =
      bal.netAmount > 0 ? '#059669' : bal.netAmount < 0 ? '#e11d48' : '#64748b'
    ctx.font = `800 19px ${fontStack}`
    ctx.fillText(
      `${netSign}${fmt(bal.netAmount)}`,
      PAD + CARD_W - 34,
      my + 28,
    )

    ctx.fillStyle = '#94a3b8'
    ctx.font = `600 13px ${fontStack}`
    const statusText =
      bal.netAmount > 0
        ? labels.shouldReceive
        : bal.netAmount < 0
          ? labels.shouldPay
          : labels.settled
    ctx.fillText(statusText, PAD + CARD_W - 34, my + 50)
    ctx.textAlign = 'left'

    my += 76
  }

  y += memberCardH + gap

  // 4. 待還款轉帳建議卡片
  drawRoundedRect(ctx, PAD, y, CARD_W, transferCardH, 22)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.strokeStyle = '#e2e8f0'
  ctx.lineWidth = 1.5
  ctx.stroke()

  ctx.fillStyle = '#334155'
  ctx.font = `700 18px ${fontStack}`
  ctx.fillText(labels.transfersSectionTitle, PAD + 24, y + 36)

  if (settleUp.transfers.length === 0) {
    drawRoundedRect(ctx, PAD + 20, y + 54, CARD_W - 40, 48, 14)
    ctx.fillStyle = '#ecfdf5'
    ctx.fill()
    ctx.fillStyle = '#065f46'
    ctx.font = `700 16px ${fontStack}`
    ctx.fillText(labels.allSettledText, PAD + 36, y + 84)
  } else {
    let ty = y + 56
    for (const tr of settleUp.transfers) {
      drawRoundedRect(ctx, PAD + 20, ty, CARD_W - 40, 46, 12)
      ctx.fillStyle = '#f8fafc'
      ctx.fill()

      ctx.fillStyle = '#0f172a'
      ctx.font = `700 17px ${fontStack}`
      ctx.fillText(
        `${nameOf(tr.fromMemberId)}  →  ${nameOf(tr.toMemberId)}`,
        PAD + 36,
        ty + 29,
      )

      ctx.textAlign = 'right'
      ctx.fillStyle = '#059669'
      ctx.font = `800 18px ${fontStack}`
      ctx.fillText(fmt(tr.amount, tr.currency), PAD + CARD_W - 36, ty + 29)
      ctx.textAlign = 'left'

      ty += 56
    }
  }

  y += transferCardH + gap

  // 5. 消費與退款明細表
  if (entriesCardH > 0) {
    drawRoundedRect(ctx, PAD, y, CARD_W, entriesCardH, 22)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.strokeStyle = '#e2e8f0'
    ctx.lineWidth = 1.5
    ctx.stroke()

    ctx.fillStyle = '#334155'
    ctx.font = `700 18px ${fontStack}`
    ctx.fillText(labels.entriesSectionTitle, PAD + 24, y + 36)

    let ey = y + 60
    for (let i = 0; i < validEntries.length; i += 1) {
      const tx = validEntries[i]
      if (i > 0) {
        ctx.beginPath()
        ctx.moveTo(PAD + 24, ey - 10)
        ctx.lineTo(PAD + CARD_W - 24, ey - 10)
        ctx.strokeStyle = '#f1f5f9'
        ctx.lineWidth = 1
        ctx.stroke()
      }

      const rawTitle =
        tx.note?.trim() || labels.resolveCategoryLabel(tx.categoryKey)
      const title =
        tx.type === 'refund' ? `[${labels.refundBadge}] ${rawTitle}` : rawTitle

      ctx.fillStyle = '#0f172a'
      ctx.font = `700 16px ${fontStack}`
      ctx.fillText(truncateText(ctx, title, CARD_W - 210), PAD + 24, ey + 14)

      const payerText = tx.splitConfig
        ? nameOf(tx.splitConfig.payerId)
        : ''
      ctx.fillStyle = '#64748b'
      ctx.font = `500 13px ${fontStack}`
      ctx.fillText(
        `${tx.date} · ${labels.resolveCategoryLabel(tx.categoryKey)}${payerText ? ` · ${payerText}` : ''}`,
        PAD + 24,
        ey + 36,
      )

      const sign = tx.type === 'refund' ? '-' : ''
      ctx.textAlign = 'right'
      ctx.fillStyle = tx.type === 'refund' ? '#0d9488' : '#0f172a'
      ctx.font = `700 17px ${fontStack}`
      ctx.fillText(
        `${sign}${fmt(tx.amount, tx.currency)}`,
        PAD + CARD_W - 24,
        ey + 18,
      )
      if (tx.currency !== project.baseCurrency) {
        ctx.fillStyle = '#d97706'
        ctx.font = `600 12px ${fontStack}`
        ctx.fillText(
          `≈ ${sign}${fmt(tx.amount * tx.exchangeRateToBase, project.baseCurrency)}`,
          PAD + CARD_W - 24,
          ey + 36,
        )
      }
      ctx.textAlign = 'left'

      ey += 58
    }

    y += entriesCardH + gap
  }

  // 6. 頁尾浮水印
  ctx.fillStyle = '#94a3b8'
  ctx.font = `600 14px ${fontStack}`
  ctx.textAlign = 'center'
  ctx.fillText(labels.footerTagline, W / 2, y + 26)

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error('ERR_PNG_ENCODE_FAILED'))
      },
      'image/png',
      0.95,
    )
  })
}
