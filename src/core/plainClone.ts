/**
 * 遞迴解除被 Proxy（例如 Vue Reactive Proxy）包裹的物件與陣列，
 * 同時保留 `undefined`、`Date`、`RegExp`、`Map`、`Set`、`ArrayBuffer` / TypedArray 等原生型別與循環參考。
 */
export function deepUnwrap<T>(
  value: T,
  unwrap: <U>(v: U) => U,
  seen = new WeakMap<object, unknown>(),
): T {
  if (value === null || typeof value !== 'object') {
    return value
  }
  const raw = unwrap(value) as unknown
  if (raw === null || typeof raw !== 'object') {
    return raw as T
  }
  if (seen.has(raw)) {
    return seen.get(raw) as T
  }

  if (
    raw instanceof Date ||
    raw instanceof RegExp ||
    raw instanceof ArrayBuffer ||
    ArrayBuffer.isView(raw)
  ) {
    return raw as T
  }

  if (Array.isArray(raw)) {
    const out: unknown[] = new Array(raw.length)
    seen.set(raw, out)
    for (let i = 0; i < raw.length; i += 1) {
      out[i] = deepUnwrap(raw[i], unwrap, seen)
    }
    return out as T
  }

  if (raw instanceof Map) {
    const out = new Map<unknown, unknown>()
    seen.set(raw, out)
    for (const [k, v] of raw.entries()) {
      out.set(deepUnwrap(k, unwrap, seen), deepUnwrap(v, unwrap, seen))
    }
    return out as T
  }

  if (raw instanceof Set) {
    const out = new Set<unknown>()
    seen.set(raw, out)
    for (const item of raw.values()) {
      out.add(deepUnwrap(item, unwrap, seen))
    }
    return out as T
  }

  const proto = Object.getPrototypeOf(raw)
  if (proto === Object.prototype || proto === null) {
    const out: Record<string, unknown> =
      proto === null ? Object.create(null) : {}
    seen.set(raw, out)
    for (const key of Object.keys(raw as Record<string, unknown>)) {
      out[key] = deepUnwrap((raw as Record<string, unknown>)[key], unwrap, seen)
    }
    return out as T
  }

  return raw as T
}

/**
 * 將可能含 Reactive Proxy 的資料深拷貝為 IndexedDB `structuredClone` 相容的純淨物件。
 *
 * 相比 `JSON.parse(JSON.stringify(value))`：
 * 1. 保留 `undefined`、`NaN`、`Date`、`Map`、`Set`、`Uint8Array` 等非 JSON 值；
 * 2. 避免將含大量收據 base64 圖片的資料序列化為超大 JSON 字串再反序列化；
 * 3. 快速路徑直接呼叫 `structuredClone(unwrap(value))`，僅在遇巢狀 Proxy 導致
 *    `DataCloneError` 時才回退執行 `deepUnwrap` 後再 `structuredClone`。
 */
export function cloneAsPlain<T>(
  value: T,
  unwrap?: <U>(v: U) => U,
): T {
  if (value === null || typeof value !== 'object') {
    return value
  }
  const topRaw = unwrap ? unwrap(value) : value
  try {
    return structuredClone(topRaw)
  } catch (err) {
    if (unwrap) {
      const unwrapped = deepUnwrap(topRaw, unwrap)
      return structuredClone(unwrapped)
    }
    throw err
  }
}
