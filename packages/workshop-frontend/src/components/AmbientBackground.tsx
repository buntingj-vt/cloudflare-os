import { useEffect, useRef } from 'react'

/**
 * Ambient backdrop layer. The visual (dotted grid + warm radial glow) is defined by `.ambient-bg`
 * in styles.css; this component only drives the glow position, easing the `--gx`/`--gy` CSS
 * variables toward the pointer so the glow trails the cursor — mirroring the reference deal-menu
 * design. Honors prefers-reduced-motion by leaving the glow centered (the CSS defaults).
 */
export default function AmbientBackground() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    // Target = pointer, current = eased position, both as viewport fractions (0..1).
    let targetX = 0.5
    let targetY = 0.5
    let curX = 0.5
    let curY = 0.5
    let raf = 0
    let running = false

    const tick = () => {
      // Exponential ease toward the target; ~0.12 gives a soft trailing glow.
      curX += (targetX - curX) * 0.12
      curY += (targetY - curY) * 0.12
      el.style.setProperty('--gx', `${(curX * 100).toFixed(2)}%`)
      el.style.setProperty('--gy', `${(curY * 100).toFixed(2)}%`)
      if (Math.abs(targetX - curX) > 0.0005 || Math.abs(targetY - curY) > 0.0005) {
        raf = requestAnimationFrame(tick)
      } else {
        running = false
      }
    }

    const kick = () => {
      if (running) return
      running = true
      raf = requestAnimationFrame(tick)
    }

    const onMove = (e: PointerEvent) => {
      targetX = e.clientX / window.innerWidth
      targetY = e.clientY / window.innerHeight
      kick()
    }

    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      cancelAnimationFrame(raf)
    }
  }, [])

  return <div ref={ref} className="ambient-bg" aria-hidden="true" />
}
