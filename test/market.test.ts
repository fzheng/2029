import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cachedQuotes,
  fetchContractTerms,
  fetchPledgeTerms,
  fetchQuotes,
  parseCandles,
  savedCandles,
} from '../src/market'

test('Bitget keeps decimal spot, mark and loan index prices separate and reports stale or missing bases', async (t) => {
  const values = new Map<string, string>()
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  })
  const now = Date.now()
  let offline = false
  let partial = false
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    if (offline || (partial && input.includes('USDT-FUTURES'))) throw new Error('offline')
    const data = input.includes('USDT-FUTURES')
      ? [
          {
            symbol: 'BTCUSDT',
            markPrice: '59999.98',
            indexPrice: '60000.012345678912345678',
            ts: String(now),
          },
        ]
      : [
          { symbol: 'BTCUSDT', lastPrice: '60001.99', price24hPcnt: '-0.05', ts: String(now) },
          { symbol: 'OLDUSDT', lastPrice: '4', ts: String(now - 600_000) },
          { symbol: 'IDLEUSDT', lastPrice: '1', volume24h: '0', ts: String(now) },
          { symbol: 'UNCLOCKEDUSDT', lastPrice: '8' },
        ]
    return Response.json({ code: '00000', data, requestTime: now })
  })
  assert.equal(cachedQuotes(['BTC']).asOf, null)
  const first = await fetchQuotes(['BTC', 'ETH', 'OLD', 'USDT'])
  assert.equal(first.book.spot.BTC, '60001.99')
  assert.equal(first.book.mark.BTC, '59999.98')
  assert.equal(first.book.loan.BTC, '60000.012345678912345678')
  assert.equal(first.changes.BTC, -5)
  assert.equal(first.book.spot.USDT, '1')
  assert.ok(first.missing.includes('mark:ETH'))
  assert.equal(first.book.mark.ETH, undefined)
  assert.deepEqual(first.symbols, ['BTC', 'IDLE', 'OLD', 'UNCLOCKED'])
  assert.deepEqual(first.stale, ['spot:OLD'])
  assert.equal(first.universeStatus['spot:IDLE'], 'stale')
  assert.equal(first.universe.spot.UNCLOCKED, undefined)
  partial = true
  const oneFeed = await fetchQuotes(['BTC'])
  assert.deepEqual(oneFeed.stale, ['mark:BTC', 'loan:BTC'])
  assert.equal(oneFeed.universe.spot.OLD, '4')
  assert.equal(oneFeed.universeStatus['spot:OLD'], 'stale')
  assert.equal(oneFeed.universeStatus['spot:BTC'], 'fresh')
  assert.equal(oneFeed.book.spot.OLD, undefined)
  offline = true
  const failed = await fetchQuotes(['BTC'])
  assert.deepEqual(failed.stale, ['spot:BTC', 'mark:BTC', 'loan:BTC'])
  assert.deepEqual(failed.book, oneFeed.book)
  assert.equal(failed.asOf, first.asOf)
  assert.deepEqual(cachedQuotes(['BTC']).book, failed.book)
})

test('candle history is ordered, deduplicated, and rejects invalid OHLC records', () => {
  const t1 = '1700000000000',
    t2 = '1700000060000'
  const rows = [
    [t2, '9', '15', '8', '10', '7'],
    [t1, '7', '10', '7', '8', '2'],
    [t2, '9', '16', '8', '11', '8'],
    ['invalid', '1', '2', '1', '2', '3'],
    ['1700000120000', '8', '7', '6', '6', '9'],
  ]
  const result = parseCandles(rows)
  assert.deepEqual(
    result.map((c) => c.time),
    [Number(t1) / 1000, Number(t2) / 1000],
  )
  assert.equal(result[1].close, 11)
  assert.equal(savedCandles('BTC', '1D')?.status, 'archived')
  assert.equal(savedCandles('ETH', '1D'), undefined)
})

test('perpetual settings preserve the exchange fee and the full sorted tier schedule', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const data = input.includes('query-position-lever')
      ? [
          { startUnit: '10000', endUnit: '15000', keepMarginRate: '0.01' },
          { startUnit: '0', endUnit: '10000', keepMarginRate: '0.003' },
        ]
      : [{ symbol: 'TESTUSDT', takerFeeRate: '0.0005' }]
    return Response.json({ code: '00000', data, requestTime: Date.now() })
  })
  const result = await fetchContractTerms('TEST')
  assert.equal(result.takerFee, '0.0005')
  assert.deepEqual(result.tiers, [
    { min: '0', max: '10000', rate: '0.003' },
    { min: '10000', max: '15000', rate: '0.01' },
  ])
})

test('pledge terms use the selected coin’s collateral row and the USDT loan row from separate queries', async (t) => {
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input, 'http://localhost')
    assert.ok(url.pathname.endsWith('/api/v2/earn/loan/public/coinInfos'))
    const coin = url.searchParams.get('coin')
    assert.ok(coin === 'SOL' || coin === 'USDT')
    requests.push(coin)
    const data =
      coin === 'SOL'
        ? {
            pledgeInfos: [
              { coin: 'BTC', minUsdt: '3', maxUsdt: '300', initRate: '0.1', forceRate: '0.8' },
              {
                coin: 'SOL',
                minUsdt: '5.001',
                maxUsdt: '85000',
                initRate: '0.625',
                forceRate: '0.8599',
              },
            ],
            loanInfos: [{ coin: 'USDT', minUsdt: '7', maxUsdt: '77777' }],
          }
        : {
            pledgeInfos: [
              { coin: 'SOL', minUsdt: '6', maxUsdt: '66000', initRate: '0.3', forceRate: '0.7' },
            ],
            loanInfos: [
              { coin: 'ETH', minUsdt: '4', maxUsdt: '4000' },
              { coin: 'USDT', minUsdt: '200.01', maxUsdt: '9999.99999999' },
            ],
          }
    return Response.json({ code: '00000', requestTime: Date.now(), data })
  })
  assert.deepEqual(await fetchPledgeTerms('SOL'), {
    borrowLtvPct: '62.5',
    liquidationLtvPct: '85.99',
    minBorrowUsdt: '200.01',
    maxBorrowUsdt: '9999.99999999',
    minCollateralUsdt: '5.001',
    maxCollateralUsdt: '85000',
  })
  assert.deepEqual(requests.sort(), ['SOL', 'USDT'])
})

test('pledge terms reject missing products, invalid published limits, invalid ratios and an offline feed', async (t) => {
  const pledge = { coin: 'SOL', minUsdt: '1', maxUsdt: '8000', initRate: '0.6', forceRate: '0.9' }
  const debt = { coin: 'USDT', minUsdt: '10', maxUsdt: '4000' }
  let collateralRows = [pledge]
  let loanRows = [debt]
  let offline = false
  const fetchMock = t.mock.method(globalThis, 'fetch', async (input: string) => {
    if (offline) throw new Error('offline')
    const isBorrowingQuery = new URL(input, 'http://localhost').searchParams.get('coin') === 'USDT'
    const data = isBorrowingQuery ? { loanInfos: loanRows } : { pledgeInfos: collateralRows }
    return Response.json({ code: '00000', requestTime: Date.now(), data })
  })
  await assert.rejects(fetchPledgeTerms('USDT'), /Unsupported collateral symbol/)
  assert.equal(fetchMock.mock.callCount(), 0)
  collateralRows = [{ ...pledge, coin: 'ETH' }]
  await assert.rejects(fetchPledgeTerms('SOL'), /No published terms/)
  collateralRows = [pledge]
  loanRows = [{ ...debt, coin: 'USDC' }]
  await assert.rejects(fetchPledgeTerms('SOL'), /No published terms/)
  loanRows = [{ ...debt, minUsdt: 'bad' }]
  await assert.rejects(fetchPledgeTerms('SOL'), /Invalid public loan terms/)
  loanRows = [{ ...debt, minUsdt: '4001' }]
  await assert.rejects(fetchPledgeTerms('SOL'), /Invalid public loan limits/)
  loanRows = [debt]
  collateralRows = [{ ...pledge, minUsdt: '8001' }]
  await assert.rejects(fetchPledgeTerms('SOL'), /Invalid public loan limits/)
  collateralRows = [{ ...pledge, forceRate: '0.60' }]
  await assert.rejects(fetchPledgeTerms('SOL'), /Invalid public loan limits/)
  collateralRows = [pledge]
  offline = true
  await assert.rejects(fetchPledgeTerms('SOL'), /offline/)
})
