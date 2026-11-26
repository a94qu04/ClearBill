/**
 * 安全的輕量四則運算與百分比解析器（絕不使用 eval 或 new Function）
 * 支援：
 * - 加減乘除與括號：350+180、1200*1.1、(500+300)/2
 * - 百分比語法：1200+10% (= 1320)、1200-15% (= 1020)、1200*10% (= 120)
 * - 自動相容全形運算符號（＋－×÷（））與千分位逗號
 */

type Token =
  | { type: 'number'; value: number; isPercent: boolean }
  | { type: 'op'; value: '+' | '-' | '*' | '/' }
  | { type: 'lparen' }
  | { type: 'rparen' }

const OPERATOR_REGEX = /[+\-*/×÷＋－（）()✕✖／—–％]/
const MULTIPLY_X_REGEX = /[\d)]\s*[xX]/

/**
 * 判斷輸入字串是否包含算式運算符號（或百分比符號）
 */
export function hasMathExpression(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return false
  return (
    OPERATOR_REGEX.test(trimmed) ||
    MULTIPLY_X_REGEX.test(trimmed) ||
    trimmed.includes('%')
  )
}

function normalizeExpressionString(raw: string): string {
  return raw
    .replace(/,/g, '')
    .replace(/＋/g, '+')
    .replace(/[－—–]/g, '-')
    .replace(/[×xX✕✖]/g, '*')
    .replace(/[÷／]/g, '/')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/％/g, '%')
    .replace(/\s+/g, '')
}

function tokenize(expr: string): Token[] | null {
  const tokens: Token[] = []
  let i = 0

  while (i < expr.length) {
    const ch = expr[i]

    if ((ch >= '0' && ch <= '9') || ch === '.') {
      let numStr = ''
      let dotCount = 0
      while (i < expr.length && ((expr[i] >= '0' && expr[i] <= '9') || expr[i] === '.')) {
        if (expr[i] === '.') {
          dotCount += 1
          if (dotCount > 1) return null
        }
        numStr += expr[i]
        i += 1
      }
      if (numStr === '.') return null
      const num = Number(numStr)
      if (!Number.isFinite(num)) return null

      let isPercent = false
      if (i < expr.length && expr[i] === '%') {
        isPercent = true
        i += 1
      }
      tokens.push({ type: 'number', value: num, isPercent })
      continue
    }

    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ type: 'op', value: ch })
      i += 1
      continue
    }

    if (ch === '(') {
      tokens.push({ type: 'lparen' })
      i += 1
      continue
    }

    if (ch === ')') {
      tokens.push({ type: 'rparen' })
      i += 1
      continue
    }

    // 含非法字元直接拒絕
    return null
  }

  return tokens
}

interface ParsedNodeValue {
  value: number
  /** 僅當節點本身為獨立百分比字面值（例如 10%）時為 true，讓 A + 10% 解讀為 A * (1 + 0.1) */
  isDirectPercent: boolean
}

class ExpressionParser {
  private readonly tokens: Token[]
  private pos = 0

  constructor(tokens: Token[]) {
    this.tokens = tokens
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos]
  }

  private consume(): Token | undefined {
    const tok = this.tokens[this.pos]
    this.pos += 1
    return tok
  }

  public parse(): number | null {
    if (this.tokens.length === 0) return null
    const result = this.parseAddSub()
    if (result === null || this.pos !== this.tokens.length) {
      return null
    }
    const finalVal = result.isDirectPercent ? result.value / 100 : result.value
    if (!Number.isFinite(finalVal) || finalVal < 0) return null
    return finalVal
  }

  private parseAddSub(): ParsedNodeValue | null {
    let left: ParsedNodeValue | null = this.parseMulDiv()
    if (left === null) return null

    while (true) {
      const next = this.peek()
      if (!next || next.type !== 'op' || (next.value !== '+' && next.value !== '-')) {
        break
      }
      this.consume()
      const right: ParsedNodeValue | null = this.parseMulDiv()
      if (right === null) return null

      const leftVal: number = left.isDirectPercent ? left.value / 100 : left.value
      const delta: number = right.isDirectPercent
        ? leftVal * (right.value / 100)
        : right.value

      const combined: number = next.value === '+' ? leftVal + delta : leftVal - delta
      if (!Number.isFinite(combined)) return null
      left = { value: combined, isDirectPercent: false }
    }

    return left
  }

  private parseMulDiv(): ParsedNodeValue | null {
    let left: ParsedNodeValue | null = this.parseUnary()
    if (left === null) return null

    while (true) {
      const next = this.peek()
      if (!next || next.type !== 'op' || (next.value !== '*' && next.value !== '/')) {
        break
      }
      this.consume()
      const right: ParsedNodeValue | null = this.parseUnary()
      if (right === null) return null

      const leftVal: number = left.isDirectPercent ? left.value / 100 : left.value
      const rightVal: number = right.isDirectPercent ? right.value / 100 : right.value

      if (next.value === '/' && rightVal === 0) return null
      const combined: number = next.value === '*' ? leftVal * rightVal : leftVal / rightVal
      if (!Number.isFinite(combined)) return null
      left = { value: combined, isDirectPercent: false }
    }

    return left
  }

  private parseUnary(): ParsedNodeValue | null {
    const tok = this.peek()
    if (tok && tok.type === 'op' && (tok.value === '+' || tok.value === '-')) {
      this.consume()
      const operand = this.parseUnary()
      if (operand === null) return null
      const val = operand.isDirectPercent ? operand.value / 100 : operand.value
      return {
        value: tok.value === '-' ? -val : val,
        isDirectPercent: false,
      }
    }
    return this.parsePrimary()
  }

  private parsePrimary(): ParsedNodeValue | null {
    const tok = this.peek()
    if (!tok) return null

    if (tok.type === 'number') {
      this.consume()
      return { value: tok.value, isDirectPercent: tok.isPercent }
    }

    if (tok.type === 'lparen') {
      this.consume()
      const inner = this.parseAddSub()
      if (inner === null) return null
      const closing = this.peek()
      if (!closing || closing.type !== 'rparen') return null
      this.consume()
      const val = inner.isDirectPercent ? inner.value / 100 : inner.value
      return { value: val, isDirectPercent: false }
    }

    return null
  }
}

/**
 * 計算數學算式並依指定小數位數四捨五入（無效或負數回傳 null）
 */
export function evaluateAmountExpression(
  raw: string,
  decimals = 2,
): number | null {
  const normalized = normalizeExpressionString(raw)
  if (!normalized) return null
  if (normalized.length > 80) return null

  const tokens = tokenize(normalized)
  if (!tokens || tokens.length === 0) return null

  const parser = new ExpressionParser(tokens)
  const rawResult = parser.parse()
  if (rawResult === null || !Number.isFinite(rawResult) || rawResult < 0) {
    return null
  }

  const safeDecimals = Math.max(0, Math.min(4, Math.floor(decimals)))
  const factor = 10 ** safeDecimals
  const rounded = Math.round(rawResult * factor) / factor
  return Object.is(rounded, -0) ? 0 : rounded
}
