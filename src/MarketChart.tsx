import { useEffect, useRef, useState } from 'react'
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import {
  fetchCandles,
  savedCandles,
  type Candle,
  type CandleHistory,
  type ChartInterval,
} from './market'
import { translate, useLanguage } from './i18n'
import './market-chart.css'

interface MarketChartProps {
  symbol?: string
  interval?: ChartInterval
  refreshKey?: string | number
  onCandle?: (candle: Candle | undefined) => void
}

const up = '#59c6a0'
const down = '#ec8168'
const intervalsZh: Record<ChartInterval, string> = {
  '1H': '1小时',
  '4H': '4小时',
  '1D': '1天',
  '1W': '1周',
}
export const intervalLabel = (interval: ChartInterval) => translate(interval, intervalsZh[interval])
const formatPrice = (n: number, locale: string) =>
  n.toLocaleString(locale, {
    minimumFractionDigits: n >= 10 ? 2 : 0,
    maximumFractionDigits: n >= 10 ? 2 : 7,
  })
const archiveDate = (millis: number, locale: string) =>
  new Date(millis).toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

export function MarketChart({
  symbol = 'BTC',
  interval = '1D',
  refreshKey,
  onCandle,
}: MarketChartProps) {
  const { t, locale } = useLanguage()
  const host = useRef<HTMLDivElement>(null)
  const chart = useRef<IChartApi | null>(null)
  const priceSeries = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeSeries = useRef<ISeriesApi<'Histogram'> | null>(null)
  const dataRef = useRef<CandleHistory | undefined>(undefined)
  const callback = useRef(onCandle)
  callback.current = onCandle
  const [history, setHistory] = useState<CandleHistory>()
  const [hover, setHover] = useState<Candle>()
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  const fit = useRef(false)

  useEffect(() => {
    if (!host.current) return
    const api = createChart(host.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#15181d' },
        textColor: '#a4a9b4',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 10,
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: '#292d35', style: LineStyle.Dashed },
        horzLines: { color: '#292d35', style: LineStyle.Dashed },
      },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.24 } },
      timeScale: { borderColor: '#30353d', rightOffset: 3, barSpacing: 8, fixLeftEdge: true },
      crosshair: {
        mode: CrosshairMode.Normal,
        horzLine: { color: '#78818b', labelBackgroundColor: '#3c434c' },
        vertLine: { color: '#78818b', labelBackgroundColor: '#3c434c' },
      },
      handleScroll: { horzTouchDrag: true, vertTouchDrag: false, mouseWheel: false },
    })
    const candles = api.addSeries(CandlestickSeries, {
      upColor: up,
      downColor: down,
      borderVisible: false,
      wickUpColor: up,
      wickDownColor: down,
      priceLineStyle: LineStyle.Dashed,
      priceLineWidth: 1,
      lastValueVisible: true,
    })
    const volume = api.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      priceLineVisible: false,
      lastValueVisible: false,
    })
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } })
    api.subscribeCrosshairMove((event) => {
      const bar = event.point && dataRef.current?.bars.find((item) => item.time === event.time)
      setHover(bar || undefined)
    })
    chart.current = api
    priceSeries.current = candles
    volumeSeries.current = volume
    return () => {
      api.remove()
      chart.current = null
      volumeSeries.current = null
      priceSeries.current = null
    }
  }, [])

  useEffect(() => {
    chart.current?.applyOptions({
      localization: {
        locale,
        dateFormat: locale === 'zh-CN' ? 'yyyy年MM月dd日' : "dd MMM 'yy",
        priceFormatter: (value: number) => formatPrice(value, locale),
      },
    })
  }, [locale])

  useEffect(() => {
    const container = host.current
    if (!container) return
    // Lightweight Charts inserts its attribution link when the plot is first painted.
    const localizeAttribution = () => {
      const link = container.querySelector<HTMLAnchorElement>('#tv-attr-logo')
      if (link) link.title = t('Charting by TradingView', '图表由 TradingView 提供')
      return Boolean(link)
    }
    if (localizeAttribution()) return
    const observer = new MutationObserver(() => {
      if (localizeAttribution()) observer.disconnect()
    })
    observer.observe(container, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [locale, t])

  useEffect(() => {
    const controller = new AbortController()
    const saved = savedCandles(symbol, interval)
    setHover(undefined)
    setError(false)
    const api = chart.current
    api
      ?.timeScale()
      .applyOptions({ timeVisible: interval === '1H' || interval === '4H', secondsVisible: false })
    function draw(next?: CandleHistory) {
      dataRef.current = next
      setHistory(next)
      const bars = next?.bars ?? []
      const series = priceSeries.current
      if (bars.length) {
        const precision = Math.min(
          10,
          Math.max(2, 3 - Math.floor(Math.log10(bars[bars.length - 1].close))),
        )
        series?.applyOptions({ priceFormat: { type: 'price', precision, minMove: 10 ** -precision } })
      }
      series?.setData(bars.map((bar) => ({ ...bar, time: bar.time as UTCTimestamp })))
      volumeSeries.current?.setData(
        bars.map((bar) => ({
          time: bar.time as UTCTimestamp,
          value: bar.volume,
          color: bar.close >= bar.open ? '#346150' : '#70483f',
        })),
      )
      // Preserve user zoom across price refreshes, reset for a newly selected market.
      if (bars.length && !fit.current && api && host.current) {
        const visible = Math.max(30, Math.min(80, Math.floor(host.current.clientWidth / 9)))
        api
          .timeScale()
          .setVisibleLogicalRange({ from: Math.max(0, bars.length - visible), to: bars.length + 2 })
        fit.current = true
      }
      callback.current?.(bars.at(-1))
    }
    draw(saved)
    async function refresh() {
      try {
        const fresh = await fetchCandles(symbol, interval, controller.signal)
        if (!controller.signal.aborted) {
          draw(fresh)
          setError(false)
        }
      } catch {
        if (controller.signal.aborted) return
        const cached = savedCandles(symbol, interval)
        draw(cached)
        setError(!cached)
      }
    }
    void refresh()
    const timer = window.setInterval(refresh, 60_000)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [symbol, interval, refreshKey, retry])

  useEffect(
    () => () => {
      fit.current = false
    },
    [symbol, interval],
  )

  const selected = hover || history?.bars.at(-1)
  return (
    <div className="market-plot-shell">
      <div
        className="market-plot"
        ref={host}
        role="img"
        aria-label={t(
          symbol + '/USDT ' + interval + ' Bitget candlesticks and trading volume',
          'Bitget ' + symbol + '/USDT ' + intervalLabel(interval) + ' K 线与成交量',
        )}
      />
      {selected && (
        <div className="market-ohlc" aria-label={t('Candle prices', 'K 线价格')}>
          {(
            [
              [t('O', '开'), t('Open', '开盘价'), selected.open],
              [t('H', '高'), t('High', '最高价'), selected.high],
              [t('L', '低'), t('Low', '最低价'), selected.low],
              [t('C', '收'), t('Close', '收盘价'), selected.close],
            ] as const
          ).map(([label, fullLabel, value]) => (
            <span key={label}>
              <abbr title={fullLabel}>{label}</abbr> <b>{formatPrice(value, locale)}</b>
            </span>
          ))}
        </div>
      )}
      {!history && (
        <div className="market-empty" role="status">
          {error ? (
            <>
              {t('Bitget chart unavailable', 'Bitget 图表暂不可用')}{' '}
              <button type="button" onClick={() => setRetry((n) => n + 1)}>
                {t('Retry', '重试')}
              </button>
            </>
          ) : (
            t('Loading Bitget candles…', '正在加载 Bitget K 线…')
          )}
        </div>
      )}
      {history && history.status !== 'live' && (
        <div className="market-history-label" role="status">
          {history.status === 'archived'
            ? t('Archived candles', '历史 K 线')
            : t('Cached candles', '缓存 K 线')}{' '}
          · {archiveDate(history.asOf, locale)}
        </div>
      )}
      <a
        className="market-attribution"
        href="https://www.tradingview.com/"
        target="_blank"
        rel="noreferrer"
      >
        TradingView Lightweight Charts™ · © 2025 TradingView, Inc.
      </a>
    </div>
  )
}

export default MarketChart
