import React from 'react'
import { AbsoluteFill, Interactive, interpolate, useCurrentFrame } from 'remotion'
import { Backdrop, Caption, ShotCard, Hl, ease } from '../components'
import { C, FONT } from '../theme'

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const
const CHIPS = ['合盖 / 换网 / 刷新都不丢', '回到原来那一行', 'tssh 跨网络漫游']

export const Terminal: React.FC = () => {
  const frame = useCurrentFrame()
  // The agent's real terminal output, revealed step by step (6 captured frames).
  const step = Math.min(6, 1 + Math.floor(frame / 20))
  return (
    <AbsoluteFill>
      <Backdrop glowY={55} />
      <Caption title={<>断线？<Hl>接着跑</Hl></>} sub="Claude 一直在服务器的 tmux 里跑" />
      <ShotCard src={`shots/term-${step}.png`} from={{ x: 285, y: 110, w: 600, h: 421 }} to={{ x: 290, y: 130, w: 540, h: 379 }} t0={20} t1={150} y={660} width={960} enter={2} />
      <div style={{ position: 'absolute', left: 80, right: 80, top: 1410, display: 'flex', flexWrap: 'wrap', gap: 22, justifyContent: 'center', fontFamily: FONT }}>
        {CHIPS.map((t, i) => (
          <Interactive.Div
            key={t}
            name={`Chip ${i + 1}`}
            style={{
              padding: '18px 34px', borderRadius: 999, fontSize: 44, fontWeight: 700, color: C.fg,
              background: 'rgba(63,179,127,.14)', border: '2px solid rgba(63,179,127,.45)',
              opacity: interpolate(frame, [70 + i * 14, 80 + i * 14], [0, 1], { ...clamp, easing: ease }),
              translate: interpolate(frame, [70 + i * 14, 86 + i * 14], ['0px 30px', '0px 0px'], { ...clamp, easing: ease }),
            }}
          >
            ✓ {t}
          </Interactive.Div>
        ))}
      </div>
    </AbsoluteFill>
  )
}
