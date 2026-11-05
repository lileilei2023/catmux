import React from 'react'
import { AbsoluteFill } from 'remotion'
import { Backdrop, Caption, Focus, ShotCard, Hl } from '../components'

export const Diff: React.FC = () => (
  <AbsoluteFill>
    <Backdrop glowY={60} />
    <Caption title={<>改了啥？<Hl>逐文件 diff</Hl></>} sub="文件树、预览、编辑，都在远端设备上" />
    <ShotCard src="shots/hero.png" from={{ x: 958, y: 170, w: 420, h: 294 }} to={{ x: 958, y: 590, w: 420, h: 294 }} t0={40} t1={100} y={700} width={960} enter={2}>
      {map => <Focus style={map({ x: 985, y: 213, w: 450, h: 26 })} from={10} />}
    </ShotCard>
  </AbsoluteFill>
)
