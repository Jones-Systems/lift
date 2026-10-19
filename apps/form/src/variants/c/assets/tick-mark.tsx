import React from 'react';
import Svg, { Path } from 'react-native-svg';
import Animated, { useAnimatedProps, type SharedValue } from 'react-native-reanimated';
import { tokens as t } from '../generatedtokens';
import { iconPaths } from './icons';
const AnimatedPath=Animated.createAnimatedComponent(Path);
const length=Math.hypot(4,4)+Math.hypot(10,-10);
export function TickMark({progress,reduced}:{progress:SharedValue<number>;reduced:boolean}){
 const animatedProps=useAnimatedProps(()=>({strokeDashoffset:reduced?0:(1-progress.value)*length,opacity:reduced?progress.value:1}));
 return <Svg width={t.size.iconSm} height={t.size.iconSm} viewBox="0 0 24 24" fill="none" stroke={t.role.icon.onAction} strokeWidth={t.size.iconStroke} strokeLinecap="round" strokeLinejoin="round"><AnimatedPath d={iconPaths.check} strokeDasharray={[length,length]} animatedProps={animatedProps}/></Svg>;
}
