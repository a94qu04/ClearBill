import type { Project, Transaction } from '@/schemas/ledgerSchema'
import type { SettleUpResult } from '@/core/settleUpEngine'
import { fromMinorUnits, toMinorUnits } from '@/core/currency'
import { partitionPoolAndHumanBalances } from '@/core/poolFund'
import { describePayers } from '@/core/txPresentation'

export interface ExcelExportLabels {
  sheets: {
    entries: string
    summary: string
  }
  headers: {
    date: string
    time: string
    type: string
    category: string
    note: string
    originalAmount: string
    currency: string
    exchangeRate: string
    baseAmount: string
    baseCurrency: string
    payers: string
    shares: string
  }
  summaryHeaders: {
    member: string
    totalExpense: string
    totalPaid: string
    netAmount: string
    transferFrom: string
    transferTo: string
    transferAmount: string
    projectTotal: string
    transfersTitle: string
    poolSectionTitle?: string
    poolPaidLabel?: string
    poolRemainingLabel?: string
  }
  typeNames: {
    expense: string
    refund: string
    transfer: string
    income: string
    card_repayment: string
  }
  resolveCategoryLabel: (categoryKey: string) => string
}

type CellValue = string | number | null | undefined

// ==================== 零依賴極簡標準 ZIP（Store 模式）打包器 ====================
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function encodeUtf8(str: string): Uint8Array {
  return new TextEncoder().encode(str)
}

interface ZipEntryInput {
  path: string
  content: string
}

function createZipArchive(entries: ZipEntryInput[]): Uint8Array {
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = encodeUtf8(entry.path)
    const dataBytes = encodeUtf8(entry.content)
    const checksum = crc32(dataBytes)

    // Local File Header (30 bytes + filename)
    const localHeader = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(localHeader.buffer)
    lv.setUint32(0, 0x04034b50, true) // PK\x03\x04
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(6, 0x0800, true) // UTF-8 flag
    lv.setUint16(8, 0, true) // compression: store (0)
    lv.setUint16(10, 0, true)
    lv.setUint16(12, 0, true)
    lv.setUint32(14, checksum, true)
    lv.setUint32(18, dataBytes.length, true)
    lv.setUint32(22, dataBytes.length, true)
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true)
    localHeader.set(nameBytes, 30)

    localParts.push(localHeader, dataBytes)

    // Central Directory Header (46 bytes + filename)
    const centralHeader = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(centralHeader.buffer)
    cv.setUint32(0, 0x02014b50, true) // PK\x01\x02
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, 0, true)
    cv.setUint16(14, 0, true)
    cv.setUint32(16, checksum, true)
    cv.setUint32(20, dataBytes.length, true)
    cv.setUint32(24, dataBytes.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, 0, true)
    cv.setUint16(32, 0, true)
    cv.setUint16(34, 0, true)
    cv.setUint16(36, 0, true)
    cv.setUint32(38, 0, true)
    cv.setUint32(42, offset, true)
    centralHeader.set(nameBytes, 46)

    centralParts.push(centralHeader)
    offset += localHeader.length + dataBytes.length
  }

  const centralSize = centralParts.reduce((acc, p) => acc + p.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true) // PK\x05\x06
  ev.setUint16(4, 0, true)
  ev.setUint16(6, 0, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  ev.setUint16(20, 0, true)

  const totalLength = offset + centralSize + eocd.length
  const output = new Uint8Array(totalLength)
  let cursor = 0
  for (const part of localParts) {
    output.set(part, cursor)
    cursor += part.length
  }
  for (const part of centralParts) {
    output.set(part, cursor)
    cursor += part.length
  }
  output.set(eocd, cursor)
  return output
}

// ==================== OOXML Worksheet 產生器 ====================
function escapeXml(str: string): string {
  // 移除 XML 1.0 禁止之控制字元與無效碼點，避免 Excel 開啟時報檔案損毀
  return str
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function sanitizeSheetName(raw: string, fallback: string): string {
  const cleaned = Array.from(
    raw
      .replace(/[\u0000-\u001F]/g, '')
      .replace(/[\\/?*[\]:]/g, ' ')
      .trim(),
  )
    .slice(0, 31)
    .join('')
  return cleaned || fallback
}

function columnIndexToLetter(index: number): string {
  let n = index + 1
  let result = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    result = String.fromCharCode(65 + rem) + result
    n = Math.floor((n - 1) / 26)
  }
  return result
}

function buildWorksheetXml(
  rows: Array<{ cells: CellValue[]; isHeader?: boolean }>,
  colWidths: number[],
): string {
  const colsXml = colWidths
    .map(
      (width, idx) =>
        `<col min="${idx + 1}" max="${idx + 1}" width="${width}" customWidth="1"/>`,
    )
    .join('')

  const rowsXml = rows
    .map((row, rowIdx) => {
      const rNum = rowIdx + 1
      const styleAttr = row.isHeader ? ' s="1"' : ''
      const cellsXml = row.cells
        .map((val, colIdx) => {
          const ref = `${columnIndexToLetter(colIdx)}${rNum}`
          if (val === null || val === undefined || val === '') {
            return `<c r="${ref}"${styleAttr}/>`
          }
          if (typeof val === 'number' && Number.isFinite(val)) {
            return `<c r="${ref}"${styleAttr}><v>${val}</v></c>`
          }
          const rawText = String(val)
          // 防範試算表公式注入（含前置空白／換行／Tab 後接 = + - @）
          const safeText = /^[\s\r\n\t]*[=+\-@]/.test(rawText)
            ? `'${rawText}`
            : rawText
          return `<c r="${ref}" t="inlineStr"${styleAttr}><is><t xml:space="preserve">${escapeXml(safeText)}</t></is></c>`
        })
        .join('')
      return `<row r="${rNum}">${cellsXml}</row>`
    })
    .join('')

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<cols>${colsXml}</cols>` +
    `<sheetData>${rowsXml}</sheetData>` +
    '</worksheet>'
  )
}

/**
 * 產生標準雙工作表 Excel 檔案（.xlsx Uint8Array）：
 * - Sheet 1：消費／退款／還款明細（數值欄皆為真實數字型別，可直接 SUM 加總）
 * - Sheet 2：成員結算總表與最少轉帳建議
 */
export function buildProjectExcelBytes(
  project: Project,
  transactions: Transaction[],
  settleUp: SettleUpResult,
  labels: ExcelExportLabels,
): Uint8Array {
  const targetCurrency = settleUp.currency || project.baseCurrency
  const memberMap = new Map<string, string>()
  for (const m of project.members) {
    memberMap.set(m.id, m.name)
  }
  const nameOf = (id: string) => memberMap.get(id) ?? id

  // Sheet 1：消費與還款明細
  const entryRows: Array<{ cells: CellValue[]; isHeader?: boolean }> = [
    {
      isHeader: true,
      cells: [
        labels.headers.date,
        labels.headers.time,
        labels.headers.type,
        labels.headers.category,
        labels.headers.note,
        labels.headers.originalAmount,
        labels.headers.currency,
        labels.headers.exchangeRate,
        labels.headers.baseAmount,
        labels.headers.baseCurrency,
        labels.headers.payers,
        labels.headers.shares,
      ],
    },
  ]

  const sortedTxs = transactions
    .filter((tx) => !tx.isDeleted && tx.projectId === project.id)
    .sort((a, b) => {
      const dateCmp = a.date.localeCompare(b.date)
      if (dateCmp !== 0) return dateCmp
      const timeCmp = a.time.localeCompare(b.time)
      if (timeCmp !== 0) return timeCmp
      return a.updatedAt - b.updatedAt
    })

  for (const tx of sortedTxs) {
    const isTransfer = tx.type === 'transfer'
    const sign = tx.type === 'refund' ? -1 : 1
    const rate = tx.exchangeRateToBase > 0 ? tx.exchangeRateToBase : 1
    const baseUnits = toMinorUnits(tx.amount * rate, targetCurrency)
    // 還款／公費收款（transfer）不列入支出基準金額欄，避免使用者對該欄 SUM() 時將還款重複計入總支出
    const signedBaseAmount: CellValue = isTransfer
      ? ''
      : sign * fromMinorUnits(baseUnits, targetCurrency)
    const signedOriginalAmount = sign * tx.amount

    const payersText = describePayers(tx, nameOf, {
      includeAmounts: true,
      separator: ' / ',
    })
    let sharesText = ''

    if (tx.splitConfig) {
      sharesText = tx.splitConfig.shares
        .filter((s) => s.finalAmount > 0)
        .map((s) => `${nameOf(s.memberId)}: ${s.finalAmount}`)
        .join(' / ')
    }

    entryRows.push({
      cells: [
        tx.date,
        tx.time !== '00:00' ? tx.time : '',
        labels.typeNames[tx.type] ?? tx.type,
        labels.resolveCategoryLabel(tx.categoryKey),
        tx.note ?? '',
        signedOriginalAmount,
        tx.currency,
        rate,
        signedBaseAmount,
        targetCurrency,
        payersText,
        sharesText,
      ],
    })
  }

  // Sheet 2：成員結算與轉帳建議（公費袋獨立分區，不混入真人成員表）
  const { poolBalances, humanBalances } = partitionPoolAndHumanBalances(
    settleUp.balances,
    project.members,
  )

  const summaryRows: Array<{ cells: CellValue[]; isHeader?: boolean }> = [
    {
      isHeader: true,
      cells: [
        project.name,
        labels.summaryHeaders.projectTotal,
        settleUp.totalProjectExpense,
        targetCurrency,
      ],
    },
    { cells: [] },
    ...(poolBalances.length > 0
      ? [
          {
            isHeader: true,
            cells: [
              labels.summaryHeaders.poolSectionTitle ?? 'Pool Fund',
              labels.summaryHeaders.poolPaidLabel ?? labels.summaryHeaders.totalPaid,
              labels.summaryHeaders.poolRemainingLabel ?? labels.summaryHeaders.netAmount,
              targetCurrency,
            ],
          },
          ...poolBalances.map((pb) => ({
            cells: [
              nameOf(pb.memberId),
              pb.totalPaid,
              -pb.netAmount,
              targetCurrency,
            ],
          })),
          { cells: [] },
        ]
      : []),
    {
      isHeader: true,
      cells: [
        labels.summaryHeaders.member,
        labels.summaryHeaders.totalExpense,
        labels.summaryHeaders.totalPaid,
        labels.summaryHeaders.netAmount,
      ],
    },
    ...humanBalances.map((bal) => ({
      cells: [
        nameOf(bal.memberId),
        bal.totalExpense,
        bal.totalPaid,
        bal.netAmount,
      ],
    })),
    { cells: [] },
    {
      isHeader: true,
      cells: [
        labels.summaryHeaders.transfersTitle,
        labels.summaryHeaders.transferFrom,
        labels.summaryHeaders.transferTo,
        labels.summaryHeaders.transferAmount,
      ],
    },
    ...settleUp.transfers.map((tr, idx) => ({
      cells: [
        idx + 1,
        nameOf(tr.fromMemberId),
        nameOf(tr.toMemberId),
        tr.amount,
      ],
    })),
  ]

  const sheet1Name = sanitizeSheetName(labels.sheets.entries, 'Entries')
  const sheet2Name = sanitizeSheetName(labels.sheets.summary, 'SettleUp')

  const sheet1Xml = buildWorksheetXml(
    entryRows,
    [13, 8, 12, 14, 24, 14, 9, 10, 14, 9, 18, 30],
  )
  const sheet2Xml = buildWorksheetXml(summaryRows, [20, 16, 16, 16])

  const contentTypesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>'

  const rootRelsXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>'

  const workbookXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets>' +
    `<sheet name="${escapeXml(sheet1Name)}" sheetId="1" r:id="rId1"/>` +
    `<sheet name="${escapeXml(sheet2Name)}" sheetId="2" r:id="rId2"/>` +
    '</sheets>' +
    '</workbook>'

  const workbookRelsXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>'

  const stylesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2">' +
    '<font><sz val="11"/><color rgb="FF1E293B"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>' +
    '</fonts>' +
    '<fills count="3">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF1E3A5F"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
    '</cellXfs>' +
    '</styleSheet>'

  return createZipArchive([
    { path: '[Content_Types].xml', content: contentTypesXml },
    { path: '_rels/.rels', content: rootRelsXml },
    { path: 'xl/workbook.xml', content: workbookXml },
    { path: 'xl/_rels/workbook.xml.rels', content: workbookRelsXml },
    { path: 'xl/styles.xml', content: stylesXml },
    { path: 'xl/worksheets/sheet1.xml', content: sheet1Xml },
    { path: 'xl/worksheets/sheet2.xml', content: sheet2Xml },
  ])
}
