import React from 'react'
import { AbsoluteFill } from 'remotion'
import { Backdrop, Caption, Focus, ShotCard, Hl } from '../components'

export const Create: React.FC = () => (
  <AbsoluteFill>
    <Backdrop glowY={60} />
    <Caption title={<>新建任务 <Hl>10 秒</Hl></>} sub="~/ 路径补全 · 选起点分支 · 权限一键选" />
    <ShotCard src="shots/create.png" from={{ x: 462, y: 320, w: 506, h: 394 }} to={{ x: 466, y: 340, w: 498, h: 388 }} t0={10} t1={110} y={690} width={960} enter={2}>
      {map => <Focus style={map({ x: 479, y: 406, w: 482, h: 112 })} from={30} />}
    </ShotCard>
  </AbsoluteFill>
)
