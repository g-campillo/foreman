import type { Appearance as AppearanceSettings } from '../../../shared/types'
import { useStore } from '../store'

const THEMES: { label: string; value: AppearanceSettings['theme'] }[] = [
  { label: 'Auto', value: 'auto' },
  { label: 'Dark', value: 'dark' },
  { label: 'Light', value: 'light' },
]

/**
 * Blur levels, in order of increasing diffusion. `null` is the only setting that
 * leaves the Tahoe Liquid Glass material intact — any vibrancy material
 * overrides it, which is the trade-off for getting real blur.
 */
const BLUR: { label: string; value: string | null }[] = [
  { label: 'Off · Liquid Glass', value: null },
  { label: 'Light', value: 'hud' },
  { label: 'Medium', value: 'under-window' },
  { label: 'Heavy', value: 'fullscreen-ui' },
]

export default function Appearance({ onClose }: { onClose: () => void }): React.JSX.Element {
  const a = useStore((s) => s.appearance)
  const set = useStore((s) => s.setAppearance)
  const idx = Math.max(
    0,
    BLUR.findIndex((b) => b.value === a.vibrancy),
  )
  const themeIdx = Math.max(
    0,
    THEMES.findIndex((t) => t.value === a.theme),
  )

  return (
    <div className="pop glass">
      <label>
        Theme · {THEMES[themeIdx].label}
        <input
          type="range"
          min={0}
          max={THEMES.length - 1}
          value={themeIdx}
          onChange={(e) => set({ theme: THEMES[Number(e.target.value)].value })}
        />
      </label>

      <label>
        Surface opacity · {Math.round(a.surfaceAlpha * 100)}%
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(a.surfaceAlpha * 100)}
          onChange={(e) => set({ surfaceAlpha: Number(e.target.value) / 100 })}
        />
      </label>

      <label>
        Terminal opacity · {Math.round(a.terminalAlpha * 100)}%
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(a.terminalAlpha * 100)}
          onChange={(e) => set({ terminalAlpha: Number(e.target.value) / 100 })}
        />
      </label>

      <label>
        Blur · {BLUR[idx].label}
        <input
          type="range"
          min={0}
          max={BLUR.length - 1}
          value={idx}
          onChange={(e) => set({ vibrancy: BLUR[Number(e.target.value)].value })}
        />
        <span style={{ color: 'rgb(var(--text-faint))', fontSize: 10 }}>
          Any blur replaces the Liquid Glass material with a macOS vibrancy one.
        </span>
      </label>

      <button className="btn" onClick={onClose}>
        Done
      </button>
    </div>
  )
}
