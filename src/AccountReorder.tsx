import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { GripVertical } from 'lucide-react'
import { useLanguage } from './i18n'
import './account-order.css'

type Row = { id: string; name: string }
type Selection = { source: string; target: string | null; keyboard: boolean }
type PointerDrag = {
  id: number
  source: string
  list: HTMLElement
  startX: number
  startY: number
  x: number
  y: number
  moved: boolean
}

function hitTest(drag: PointerDrag) {
  const row = document.elementFromPoint(drag.x, drag.y)?.closest<HTMLElement>('[data-order-account]')
  return row?.parentElement === drag.list ? (row.dataset.orderAccount ?? null) : null
}

export function useAccountReorder(
  rows: Row[],
  onMove: (source: string, target: string) => void,
  manual: boolean,
) {
  const { t } = useLanguage()
  const scope = useId()
  const gripId = (id: string) => scope + '-grip-' + id
  const enabled = manual && rows.length > 1
  const names = new Map(rows.map((row) => [row.id, row.name]))
  const ids = Array.from(names.keys())
  const listKey = JSON.stringify(ids)
  const [selection, setSelection] = useState<Selection | null>(null)
  const pointer = useRef<PointerDrag | null>(null)
  const restoreFocus = useRef<string | null>(null)

  // A filter change or a change from another tab invalidates a pending gesture.
  useEffect(() => {
    pointer.current = null
    setSelection(null)
    if (restoreFocus.current !== null) {
      const button = document.getElementById(scope + '-grip-' + restoreFocus.current)
      if (document.activeElement === document.body) button?.focus({ preventScroll: true })
      restoreFocus.current = null
    }
  }, [enabled, listKey, scope])

  const pointerActive = selection?.keyboard === false
  useEffect(() => {
    if (!pointerActive) return
    let frame: number
    const tick = () => {
      const drag = pointer.current
      if (!drag) return
      if (drag.moved) {
        const edge = 56
        const distance = drag.y < edge ? drag.y - edge : Math.max(0, drag.y - window.innerHeight + edge)
        if (distance) {
          window.scrollBy(0, Math.max(-16, Math.min(16, distance * 0.35)))
          const target = hitTest(drag)
          setSelection((current) =>
            current && current.target !== target ? { ...current, target } : current,
          )
        }
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [pointerActive])

  function cancel() {
    pointer.current = null
    setSelection(null)
  }

  function startPointer(event: PointerEvent<HTMLButtonElement>, source: string) {
    if (event.button !== 0 || !event.isPrimary) return
    const list = event.currentTarget.closest('[data-order-account]')?.parentElement
    if (!list) return
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    pointer.current = {
      id: event.pointerId,
      source,
      list,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    }
    setSelection({ source, target: source, keyboard: false })
  }

  function movePointer(event: PointerEvent<HTMLButtonElement>) {
    const drag = pointer.current
    if (!drag || event.pointerId !== drag.id) return
    drag.x = event.clientX
    drag.y = event.clientY
    if (!drag.moved && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 4) return
    drag.moved = true
    const target = hitTest(drag)
    setSelection((current) => (current && current.target !== target ? { ...current, target } : current))
  }

  function finishPointer(event: PointerEvent<HTMLButtonElement>) {
    const drag = pointer.current
    if (!drag || event.pointerId !== drag.id) return
    drag.x = event.clientX
    drag.y = event.clientY
    const target = hitTest(drag)
    cancel()
    if (drag.moved && target && target !== drag.source) onMove(drag.source, target)
  }

  function toggleKeyboard(source: string) {
    if (selection?.keyboard && selection.source === source) {
      const target = selection.target
      cancel()
      if (target && source !== target) {
        restoreFocus.current = source
        onMove(source, target)
      }
    } else {
      setSelection({ source, target: source, keyboard: true })
    }
  }

  function keyDown(event: KeyboardEvent<HTMLButtonElement>, source: string) {
    if (event.key === 'Escape' && selection) {
      event.preventDefault()
      cancel()
    } else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      if (!event.repeat) toggleKeyboard(source)
    } else if (
      selection?.keyboard &&
      selection.target &&
      (event.key === 'ArrowUp' || event.key === 'ArrowDown')
    ) {
      event.preventDefault()
      const index = ids.indexOf(selection.target) + (event.key === 'ArrowUp' ? -1 : 1)
      if (index < 0 || index >= ids.length) return
      const target = ids[index]
      setSelection({ ...selection, target })
      document.getElementById(gripId(target))?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }

  const position = selection?.target ? ids.indexOf(selection.target) + 1 : 0
  const pickedName = selection ? names.get(selection.source) : undefined
  const edge =
    selection && position > 0 && selection.source !== selection.target
      ? ids.indexOf(selection.source) < position - 1
        ? 'after'
        : 'before'
      : undefined
  return {
    rowProps: (id: string) => ({
      'data-order-account': enabled ? id : undefined,
      'data-order-picked': enabled && selection?.source === id ? true : undefined,
      'data-order-edge': enabled && selection?.target === id ? edge : undefined,
    }),
    grip: (id: string) => {
      const name = names.get(id)
      if (!enabled || name === undefined) return null
      const label = t('Reorder ' + name, '调整 ' + name + ' 的顺序')
      return (
        <button
          type="button"
          id={gripId(id)}
          className="account-grip"
          title={label}
          aria-label={label}
          aria-describedby={scope + '-instructions'}
          aria-pressed={selection?.source === id}
          onPointerDown={(e) => startPointer(e, id)}
          onPointerMove={movePointer}
          onPointerUp={finishPointer}
          onPointerCancel={cancel}
          onLostPointerCapture={() => {
            if (pointer.current) cancel()
          }}
          onKeyDown={(e) => keyDown(e, id)}
          onBlur={() => {
            if (selection?.keyboard) cancel()
          }}
          onClick={(e) => {
            if (e.detail === 0) toggleKeyboard(id)
          }}
        >
          <GripVertical size={17} aria-hidden="true" />
        </button>
      )
    },
    announcer: enabled && (
      <>
        <span id={scope + '-instructions'} className="order-assistive">
          {t(
            'Drag to reorder. With the keyboard, press Space to pick up, use the arrow keys to move, and press Space to drop or Escape to cancel.',
            '拖动手柄调整顺序。也可以按空格键选中，用上下方向键移动，再按空格键放下或按 Esc 键取消。',
          )}
        </span>
        <span className="order-assistive" role="status">
          {selection?.keyboard &&
            pickedName &&
            position > 0 &&
            t(
              pickedName + ', position ' + position + ' of ' + rows.length,
              pickedName + '，第 ' + position + ' 位，共 ' + rows.length + ' 个账户',
            )}
        </span>
      </>
    ),
  }
}
