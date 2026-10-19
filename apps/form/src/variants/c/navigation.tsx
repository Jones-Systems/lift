import React, { useEffect, useState } from 'react';
import { View, Pressable, Platform, Modal, type LayoutRectangle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { Box, Txt, Button, type ControlState } from './primitives';
import { t, s, useMargin, focusStyle, shadow, easingOut } from './theme';
import { Icon, StatusGlyphs } from './assets/icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';
import { useFrame, focusMarginElement } from './capture';
import type { ScreenId } from '../../types';
export const screens:ScreenId[]=['today','plan','workout','coach','progress'];
export function WebStatus() {
 return Platform.OS==='web'?<View accessible={false} importantForAccessibility="no-hide-descendants" style={{height:t.render.safeTop,flexShrink:0}}>
   <Txt role="labelMd" chrome style={{position:'absolute',left:t.render.statusInset,top:t.render.statusTop}}>9:41</Txt>
   <View style={{position:'absolute',top:t.render.islandTop,alignSelf:'center',width:t.render.islandWidth,height:t.render.islandHeight,borderRadius:t.render.islandRadius,backgroundColor:t.role.text.primary}}/>
   <View style={{position:'absolute',right:t.render.statusInset,top:t.render.statusTop,flexDirection:'row',gap:t.render.statusIconGap,alignItems:'center'}}><StatusGlyphs/></View>
 </View>:null;
}
export function HomeArea() {
 const insets=useSafeAreaInsets();
 return <View accessible={false} importantForAccessibility="no" style={{height:Platform.OS==='web'?t.render.safeBottom:insets.bottom,backgroundColor:t.role.surface.bar,flexShrink:0}}>{Platform.OS==='web'&&<View style={{position:'absolute',bottom:t.render.homeBottom,alignSelf:'center',width:t.render.homeWidth,height:t.render.homeHeight,borderRadius:t.radius.xs,backgroundColor:t.role.text.primary}}/>}</View>;
}
export function Tabs({screen,onChange,prefix='c-tab-',visualState='default'}:{screen:ScreenId;onChange?:(s:ScreenId)=>void;prefix?:string;visualState?:ControlState}) {
 return <View accessibilityRole="tablist" style={{height:t.layout.tabBarHeight,borderTopWidth:t.border.hairline,borderTopColor:t.role.line.ruling,flexDirection:'row',backgroundColor:t.role.surface.bar,flexShrink:0}}>{screens.map(id=><Tab key={id} screen={id} selected={id===screen} onPress={()=>onChange?.(id)} testID={prefix+id} visualState={visualState}/>)}</View>;
}
function Tab({screen,selected,onPress,testID,visualState}:{screen:ScreenId;selected:boolean;onPress:()=>void;testID:string;visualState:ControlState}) {
 const frame=useFrame<View>(testID);const [focused,setFocused]=useState(false);
 return <Pressable {...frame} testID={testID} accessibilityRole="tab" accessibilityState={{selected}} accessibilityLabel={screen[0].toUpperCase()+screen.slice(1)} onPress={onPress} onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)} style={({pressed})=>[{flex:1,position:'relative',alignItems:'center',paddingTop:t.render.tabIconTop,gap:t.space.xxs,minWidth:t.space.none,backgroundColor:pressed||visualState==='pressed'?t.role.surface.pressed:undefined,borderRadius:t.radius.xs},(focused||visualState==='focus')&&focusStyle]}>
   {selected&&<View style={{position:'absolute',top:t.space.none,width:t.size.tabIndicatorWidth,height:t.size.tabIndicatorHeight,backgroundColor:t.role.line.selected}}/>}
   <Icon name={screen} color={selected?t.role.icon.selected:t.role.icon.muted}/><Txt role="labelSm" tab tone={selected?'accent':'secondary'} numberOfLines={1}>{screen[0].toUpperCase()+screen.slice(1)}</Txt>
 </Pressable>;
}
export function ConfirmationBody({count,onKeep,onConfirm,prefix='c-workout-reset-',includeInset=true,onControlLayout}: {count:number;onKeep?:()=>void;onConfirm?:()=>void;prefix?:string;includeInset?:boolean;onControlLayout?:(index:number,rect:LayoutRectangle)=>void}) {
 const insets=useSafeAreaInsets();
 return <Box testID={prefix+'sheet'} accessibilityViewIsModal onAccessibilityEscape={onKeep} style={{backgroundColor:t.role.surface.raised,borderTopLeftRadius:t.radius.lg,borderTopRightRadius:t.radius.lg,borderCurve:'continuous',paddingHorizontal:t.space.lg,paddingTop:t.space.xl,paddingBottom:t.space.xl+(includeInset?(Platform.OS==='web'?t.render.safeBottom:insets.bottom):t.space.none),boxShadow:shadow('sheet')}}>
   <View style={{flexDirection:'row',alignItems:'flex-start'}}><Txt role="titleLg" accessibilityRole="header" accessible testID={prefix+'title'} style={s.flex}>Start this workout over?</Txt><View onLayout={e=>onControlLayout?.(0,{...e.nativeEvent.layout,y:e.nativeEvent.layout.y+t.space.xl,x:e.nativeEvent.layout.x+t.space.lg})}><Button kind="text" label="Close" onPress={onKeep} testID={prefix+'close'}/></View></View>
   <Txt tone="secondary" style={s.smallGap}>This clears {count} confirmed sets from today. Earlier days are not affected.</Txt>
   <View style={s.footerGap} onLayout={e=>onControlLayout?.(1,e.nativeEvent.layout)}><Button label="Keep my sets" onPress={onKeep} testID={prefix+'keep'}/></View>
   <View style={s.gap} onLayout={e=>onControlLayout?.(2,e.nativeEvent.layout)}><Button label="Start over" kind="secondary" caution onPress={onConfirm} testID={prefix+'confirm'}/></View>
 </Box>;
}
export function ResetSheet({visible,count,onKeep,onConfirm}:{visible:boolean;count:number;onKeep:()=>void;onConfirm:()=>void}) {
 const {reducedMotion}=useMargin();const progress=useSharedValue(0),offset=useSharedValue(0),height=useSharedValue(1),startX=useSharedValue(0),startY=useSharedValue(0),closing=useSharedValue(false),scrimBase=useSharedValue(1),controls=useSharedValue<LayoutRectangle[]>([]);
 const [mounted,setMounted]=useState(visible);
 const duration=reducedMotion?t.motion.duration.reducedFade:t.motion.duration.sheet;
 const close=(complete:()=>void=onKeep)=>{
  if(closing.value)return;closing.value=true;scrimBase.value=reducedMotion?1:1-offset.value/height.value;
  if(!reducedMotion)offset.value=withTiming(offset.value+t.motion.distance.sheetFrom,{duration,easing:easingOut});
  progress.value=withTiming(0,{duration,easing:easingOut},finished=>{if(finished)scheduleOnRN(complete);});
 };
 const keep=()=>{close();};
 useEffect(()=>{
   if(visible){setMounted(true);closing.value=false;offset.value=0;progress.value=0;progress.value=withTiming(1,{duration,easing:easingOut});requestAnimationFrame(()=>focusMarginElement('c-workout-reset-title'));}
   else{setMounted(false);requestAnimationFrame(()=>focusMarginElement('c-workout-reset'));}
 },[visible,reducedMotion,duration,offset,progress,closing]);
 const limits=t.gesture.sheetDismiss;
 const pan=Gesture.Pan().maxPointers(limits.maxPointers).manualActivation(true)
  .onTouchesDown((event,manager)=>{
    if(event.numberOfTouches!==limits.maxPointers||closing.value){manager.fail();return;}
    const touch=event.allTouches[0];if(!touch)return;
    if(controls.value.some(r=>touch.x>=r.x&&touch.x<=r.x+r.width&&touch.y>=r.y&&touch.y<=r.y+r.height)){manager.fail();return;}
    startX.value=touch.absoluteX;startY.value=touch.absoluteY;
  })
  .onTouchesMove((event,manager)=>{
    if(event.numberOfTouches!==limits.maxPointers){manager.fail();return;}
    const touch=event.allTouches[0];if(!touch)return;
    const dx=touch.absoluteX-startX.value,dy=touch.absoluteY-startY.value;
    if(dy>=limits.activationTravel&&dy>=Math.abs(dx)*limits.verticalDominance)manager.activate();
    else if(dy<=-limits.activationTravel||Math.abs(dx)>=limits.activationTravel&&Math.abs(dx)*limits.verticalDominance>Math.abs(dy))manager.fail();
  })
  .onUpdate(event=>{if(!closing.value)offset.value=Math.max(0,Math.min(height.value,event.translationY));})
  .onEnd(event=>{
    const d=Math.max(0,Math.min(height.value,event.translationY));
    if(d>=limits.dismissTravel||d>=limits.flingMinTravel&&event.velocityY>=limits.dismissVelocity){
      closing.value=true;scrimBase.value=reducedMotion?1:1-d/height.value;
      if(!reducedMotion)offset.value=withTiming(d+t.motion.distance.sheetFrom,{duration,easing:easingOut});
      progress.value=withTiming(0,{duration,easing:easingOut},finished=>{if(finished)scheduleOnRN(onKeep);});
    }else offset.value=withTiming(0,{duration:t.motion.duration.sheet,easing:easingOut});
  })
  .onFinalize((_event,success)=>{if(!success&&!closing.value)offset.value=withTiming(0,{duration:t.motion.duration.sheet,easing:easingOut});});
 const motion=useAnimatedStyle(()=>({opacity:progress.value,transform:[{translateY:reducedMotion?t.space.none:offset.value+(closing.value?t.space.none:(1-progress.value)*t.motion.distance.sheetFrom)}]}));
 const scrim=useAnimatedStyle(()=>({opacity:progress.value*(closing.value?scrimBase.value:reducedMotion?1:1-offset.value/height.value)}));
 if(!mounted)return null;
 const content=<View style={{flex:1,justifyContent:'flex-end'}} onAccessibilityEscape={keep}>
   <Animated.View style={[{position:'absolute',top:t.space.none,bottom:t.space.none,left:t.space.none,right:t.space.none,backgroundColor:t.role.overlay.scrim},scrim]}><Pressable accessibilityRole="button" accessibilityLabel="Keep my sets" onPress={keep} style={{flex:1}}/></Animated.View>
   <GestureDetector gesture={pan}><Animated.View onLayout={e=>{height.value=e.nativeEvent.layout.height;}} style={motion}><ConfirmationBody count={count} onKeep={keep} onConfirm={()=>close(onConfirm)} onControlLayout={(index,rect)=>{const next=[...controls.value];next[index]=rect;controls.value=next;}}/></Animated.View></GestureDetector>
 </View>;
 return Platform.OS==='web'?<View style={{position:'absolute',top:t.space.none,bottom:t.space.none,left:t.space.none,right:t.space.none}}>{content}</View>:<Modal visible transparent animationType="none" onRequestClose={keep} onShow={()=>focusMarginElement('c-workout-reset-title')} statusBarTranslucent>{content}</Modal>;
}
